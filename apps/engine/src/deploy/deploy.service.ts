import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync, statSync, type Stats } from 'node:fs';
import type {
  DeployEvent,
  DeployStep,
  DeployTargetSummary,
  DeployUploadConfig,
  DeploymentDetail,
  DeploymentStatus,
  DeploymentStepResult,
  DeploymentSummary,
  ParsedDeployScript,
  StartDeployResult,
} from '@vision/shared';
import type { Client } from 'ssh2';
import { Observable, Subject, concat, defer, from, mergeMap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { GithubSourceService } from '../projects/github-source.service';
import { ServersService } from './servers.service';
import { buildPlan, runPipeline, type RunConfig } from './ssh-runner';
import { ParseScriptDto, UpsertDeployTargetDto } from './deploy-target.dto';
import { parsePowershellDeployScript } from './script-parser';

const LOG_CAP = 2 * 1024 * 1024; // persisted log cap; live stream is unaffected
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const SCRIPT_SIZE_CAP = 2 * 1024 * 1024;

interface RunHandle {
  targetId: string;
  events: DeployEvent[];
  subject: Subject<DeployEvent>;
  cancelled: boolean;
  cancelReason?: string;
  client: Client | null;
  /** set while the run is paused waiting for an answer to a `prompt` event */
  pending?: { stepIndex: number; resolve: (answer: boolean) => void };
}

/**
 * Deploy targets + deployment runs. Live runs keep an in-memory event buffer
 * so the SSE stream can replay everything already emitted and then tail —
 * refresh-safe. Finished runs replay from the persisted row.
 */
@Injectable()
export class DeployService {
  /** live runs by deployment id */
  private readonly active = new Map<string, RunHandle>();
  /** targets with a run in flight — one deployment per target at a time */
  private readonly activeTargets = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly servers: ServersService,
    private readonly github: GithubSourceService,
  ) {}

  // ── Targets ────────────────────────────────────────────────────────────────

  async listTargets(projectId: string): Promise<DeployTargetSummary[]> {
    const rows = await this.prisma.deployTarget.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: {
        server: true,
        deployments: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
    return rows.map((t) => this.serializeTarget(t));
  }

  async createTarget(projectId: string, dto: UpsertDeployTargetDto): Promise<DeployTargetSummary> {
    if (!dto.name || !dto.serverId || !dto.workingDir) {
      throw new BadRequestException('name, serverId and workingDir are required');
    }
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`No project ${projectId}`);
    const server = await this.prisma.server.findUnique({ where: { id: dto.serverId } });
    if (!server) throw new NotFoundException(`No server ${dto.serverId}`);
    this.validateHealthUrl(dto.healthUrl);

    const row = await this.prisma.deployTarget.create({
      data: {
        projectId,
        serverId: dto.serverId,
        name: dto.name,
        workingDir: dto.workingDir,
        preflightJson: JSON.stringify(dto.preflight ?? []),
        uploadJson: dto.upload ? JSON.stringify(dto.upload) : null,
        branch: dto.branch || null,
        stepsJson: JSON.stringify(dto.steps ?? []),
        localPreJson: JSON.stringify(dto.localPre ?? []),
        localPostJson: JSON.stringify(dto.localPost ?? []),
        scriptPath: dto.scriptPath || null,
        healthUrl: dto.healthUrl || null,
      },
      include: { server: true, deployments: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    return this.serializeTarget(row);
  }

  async updateTarget(id: string, dto: UpsertDeployTargetDto): Promise<DeployTargetSummary> {
    const existing = await this.prisma.deployTarget.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No deploy target ${id}`);
    if (dto.serverId) {
      const server = await this.prisma.server.findUnique({ where: { id: dto.serverId } });
      if (!server) throw new NotFoundException(`No server ${dto.serverId}`);
    }
    this.validateHealthUrl(dto.healthUrl);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.serverId !== undefined) data.serverId = dto.serverId;
    if (dto.workingDir !== undefined) data.workingDir = dto.workingDir;
    if (dto.preflight !== undefined) data.preflightJson = JSON.stringify(dto.preflight);
    if (dto.upload !== undefined) data.uploadJson = dto.upload ? JSON.stringify(dto.upload) : null;
    if (dto.branch !== undefined) data.branch = dto.branch || null;
    if (dto.steps !== undefined) data.stepsJson = JSON.stringify(dto.steps);
    if (dto.localPre !== undefined) data.localPreJson = JSON.stringify(dto.localPre);
    if (dto.localPost !== undefined) data.localPostJson = JSON.stringify(dto.localPost);
    if (dto.scriptPath !== undefined) data.scriptPath = dto.scriptPath || null;
    if (dto.healthUrl !== undefined) data.healthUrl = dto.healthUrl || null;

    const row = await this.prisma.deployTarget.update({
      where: { id },
      data,
      include: { server: true, deployments: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    return this.serializeTarget(row);
  }

  async deleteTarget(id: string): Promise<{ ok: true }> {
    const existing = await this.prisma.deployTarget.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No deploy target ${id}`);
    if (this.activeTargets.has(id)) {
      throw new ConflictException('A deployment is currently running for this target');
    }
    await this.prisma.deployTarget.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Statically parse a PowerShell deploy script into target config. The script
   * is NEVER executed and any PEM path inside it is ignored.
   */
  async parseScript(dto: ParseScriptDto): Promise<ParsedDeployScript> {
    let text = dto.content;
    if (!text) {
      const p = (dto.path ?? '').trim();
      if (!p) throw new BadRequestException('Provide either a script path or its contents');
      if (!/\.ps1$/i.test(p)) throw new BadRequestException('Only .ps1 deploy scripts are supported');
      let stat: Stats;
      try {
        stat = statSync(p);
      } catch {
        throw new BadRequestException(`Could not read ${p} — check the path`);
      }
      if (!stat.isFile()) throw new BadRequestException(`${p} is not a file`);
      if (stat.size > SCRIPT_SIZE_CAP) throw new BadRequestException('Script is larger than 2 MB');
      text = readFileSync(p, 'utf8');
    }
    return parsePowershellDeployScript(text);
  }

  private validateHealthUrl(url: string | null | undefined): void {
    if (url && !/^https?:\/\//i.test(url)) {
      throw new BadRequestException('healthUrl must be an http(s) URL');
    }
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  async start(targetId: string): Promise<StartDeployResult> {
    const target = await this.prisma.deployTarget.findUnique({
      where: { id: targetId },
      include: { server: true },
    });
    if (!target) throw new NotFoundException(`No deploy target ${targetId}`);
    if (this.activeTargets.has(targetId)) {
      throw new ConflictException(`A deployment is already running for "${target.name}"`);
    }
    // rows stuck in `running` from a crashed/restarted engine are dead — close them
    await this.prisma.deployment.updateMany({
      where: { targetId, status: 'running' },
      data: { status: 'failed', error: 'engine restarted mid-deploy', finishedAt: new Date() },
    });

    const upload = target.uploadJson
      ? (JSON.parse(target.uploadJson) as DeployUploadConfig)
      : undefined;
    const cfg: RunConfig = {
      auth: await this.servers.auth(target.serverId),
      workingDir: target.workingDir,
      preflight: JSON.parse(target.preflightJson) as string[],
      upload,
      steps: JSON.parse(target.stepsJson) as DeployStep[],
      localPre: JSON.parse(target.localPreJson) as DeployStep[],
      localPost: JSON.parse(target.localPostJson) as DeployStep[],
      healthUrl: target.healthUrl ?? undefined,
    };
    // local steps run from the project checkout on this machine
    const localProject = await this.prisma.project.findUnique({ where: { id: target.projectId } });
    cfg.localCwd = upload?.localDir || localProject?.rootPath || undefined;
    if (target.branch && upload) {
      const branch = target.branch;
      const project = await this.prisma.project.findUnique({
        where: { id: target.projectId },
      });
      // fetch the pinned branch fresh from the git remote at package time —
      // errors surface as a failed package step in the live console
      cfg.source = {
        branch,
        fetchTree: async (log) => {
          const remote =
            project?.source === 'github' && project.repoUrl
              ? project.repoUrl
              : await this.github.originUrl(upload.localDir);
          if (!remote) {
            throw new Error(
              `no git remote found in ${upload.localDir} — add an origin or clear the target's branch`,
            );
          }
          log(`fetching ${branch} from ${remote}\n`);
          return (await this.github.resolve({ repoUrl: remote, branch })).rootPath;
        },
      };
    }
    const plan = buildPlan(cfg);

    const deployment = await this.prisma.deployment.create({
      data: {
        targetId,
        projectId: target.projectId,
        status: 'running',
        stepsJson: JSON.stringify(plan),
      },
    });

    const handle: RunHandle = {
      targetId,
      events: [],
      subject: new Subject<DeployEvent>(),
      cancelled: false,
      client: null,
    };
    this.active.set(deployment.id, handle);
    this.activeTargets.add(targetId);

    void this.execute(deployment.id, handle, cfg, plan);
    return { deploymentId: deployment.id };
  }

  private async execute(
    deploymentId: string,
    handle: RunHandle,
    cfg: Parameters<typeof buildPlan>[0],
    plan: DeploymentStepResult[],
  ): Promise<void> {
    let log = '';
    let truncated = false;
    let lastFlush = 0;

    const flush = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastFlush < 1000) return;
      lastFlush = now;
      await this.prisma.deployment
        .update({
          where: { id: deploymentId },
          data: { stepsJson: JSON.stringify(plan), log, truncated },
        })
        .catch(() => {});
    };
    const emit = (ev: DeployEvent) => {
      handle.events.push(ev);
      handle.subject.next(ev);
    };
    const logFn = (stepIndex: number, chunk: string) => {
      if (!truncated) {
        log += chunk;
        if (log.length > LOG_CAP) {
          log = log.slice(0, LOG_CAP) + '\n… [log truncated at 2 MB]\n';
          truncated = true;
        }
      }
      emit({ type: 'log', stepIndex, chunk });
      void flush();
    };

    const watchdog = setTimeout(() => {
      void this.cancel(deploymentId, `timed out after ${RUN_TIMEOUT_MS / 60000} minutes`);
    }, RUN_TIMEOUT_MS);

    let status: DeploymentStatus;
    let error: string | undefined;
    try {
      const result = await runPipeline({
        ...cfg,
        plan,
        emit,
        log: logFn,
        isCancelled: () => handle.cancelled,
        registerClient: (client) => {
          handle.client = client;
        },
        confirm: (stepIndex, message, defaultYes) => {
          if (handle.cancelled) return Promise.resolve(false);
          return new Promise<boolean>((resolve) => {
            handle.pending = { stepIndex, resolve };
            emit({ type: 'prompt', stepIndex, message, defaultYes });
          });
        },
      });
      status = handle.cancelled ? 'cancelled' : result.status;
      error = handle.cancelled ? handle.cancelReason : result.error;
    } catch (err) {
      // runPipeline handles per-step errors; this catches infrastructure bugs
      status = handle.cancelled ? 'cancelled' : 'failed';
      error = err instanceof Error ? err.message : String(err);
    }
    clearTimeout(watchdog);

    await this.prisma.deployment
      .update({
        where: { id: deploymentId },
        data: {
          status,
          error: error ?? null,
          finishedAt: new Date(),
          stepsJson: JSON.stringify(plan),
          log,
          truncated,
        },
      })
      .catch(() => {});

    emit({ type: 'done', status, error });
    handle.subject.complete();
    this.active.delete(deploymentId);
    this.activeTargets.delete(handle.targetId);
  }

  /** Answer a pending `prompt` so the paused run can continue. */
  async respond(id: string, stepIndex: number, answer: boolean): Promise<{ ok: true }> {
    const handle = this.active.get(id);
    if (!handle) throw new NotFoundException(`No running deployment ${id}`);
    const pending = handle.pending;
    if (!pending || pending.stepIndex !== stepIndex) {
      throw new BadRequestException('No prompt is awaiting an answer for that step');
    }
    handle.pending = undefined;
    const ev: DeployEvent = { type: 'prompt-resolved', stepIndex, answer };
    handle.events.push(ev);
    handle.subject.next(ev);
    pending.resolve(answer);
    return { ok: true };
  }

  async cancel(id: string, reason?: string): Promise<{ ok: true }> {
    const handle = this.active.get(id);
    if (handle) {
      handle.cancelled = true;
      handle.cancelReason = reason ?? 'cancelled by user';
      // unblock a run parked on a prompt, then force-close a hung command
      handle.pending?.resolve(false);
      handle.pending = undefined;
      handle.client?.end();
      return { ok: true };
    }
    // no live handle — a stale `running` row from a crashed engine
    const row = await this.prisma.deployment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`No deployment ${id}`);
    if (row.status === 'running') {
      await this.prisma.deployment.update({
        where: { id },
        data: { status: 'cancelled', error: reason ?? 'cancelled', finishedAt: new Date() },
      });
    }
    return { ok: true };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async detail(id: string): Promise<DeploymentDetail> {
    const row = await this.prisma.deployment.findUnique({
      where: { id },
      include: { target: true },
    });
    if (!row) throw new NotFoundException(`No deployment ${id}`);
    return {
      ...this.summaryOf(row, row.target.name),
      steps: JSON.parse(row.stepsJson) as DeploymentStepResult[],
      log: row.log,
      truncated: row.truncated,
    };
  }

  async history(projectId: string, limit: number): Promise<DeploymentSummary[]> {
    const rows = await this.prisma.deployment.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { target: true },
    });
    return rows.map((r) => this.summaryOf(r, r.target.name));
  }

  /**
   * SSE source. Live runs: replay the buffered events, then tail the subject
   * (`defer` makes slice+subscribe atomic — Node is single-threaded, so no
   * event can slip between them). Finished runs: synthesize a replay from the
   * persisted row and complete.
   */
  stream(id: string): Observable<DeployEvent> {
    return defer(() => {
      const handle = this.active.get(id);
      if (handle) {
        return concat(from(handle.events.slice()), handle.subject.asObservable());
      }
      return from(this.replayFinished(id)).pipe(mergeMap((events) => from(events)));
    });
  }

  private async replayFinished(id: string): Promise<DeployEvent[]> {
    const row = await this.prisma.deployment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`No deployment ${id}`);
    const steps = JSON.parse(row.stepsJson) as DeploymentStepResult[];
    const events: DeployEvent[] = [];
    steps.forEach((s, i) => {
      if (s.status !== 'pending') {
        events.push({
          type: 'step',
          stepIndex: i,
          status: s.status,
          exitCode: s.exitCode,
          durationMs: s.durationMs,
        });
      }
    });
    if (row.log) events.push({ type: 'log', stepIndex: 0, chunk: row.log });
    events.push({
      type: 'done',
      status: row.status as DeploymentStatus,
      error: row.error ?? undefined,
    });
    return events;
  }

  private summaryOf(
    row: {
      id: string;
      targetId: string;
      projectId: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      error: string | null;
    },
    targetName: string,
  ): DeploymentSummary {
    return {
      id: row.id,
      targetId: row.targetId,
      targetName,
      projectId: row.projectId,
      status: row.status as DeploymentStatus,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString(),
      durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : undefined,
      error: row.error ?? undefined,
    };
  }

  private serializeTarget(t: {
    id: string;
    projectId: string;
    serverId: string;
    name: string;
    workingDir: string;
    preflightJson: string;
    uploadJson: string | null;
    branch: string | null;
    stepsJson: string;
    localPreJson: string;
    localPostJson: string;
    scriptPath: string | null;
    healthUrl: string | null;
    createdAt: Date;
    server: { name: string; host: string; username: string };
    deployments: { id: string; status: string; startedAt: Date }[];
  }): DeployTargetSummary {
    const last = t.deployments[0];
    return {
      id: t.id,
      projectId: t.projectId,
      name: t.name,
      serverId: t.serverId,
      serverName: t.server.name,
      host: t.server.host,
      username: t.server.username,
      workingDir: t.workingDir,
      preflight: JSON.parse(t.preflightJson) as string[],
      upload: t.uploadJson ? (JSON.parse(t.uploadJson) as DeployUploadConfig) : undefined,
      branch: t.branch ?? undefined,
      steps: JSON.parse(t.stepsJson) as DeployStep[],
      localPre: JSON.parse(t.localPreJson) as DeployStep[],
      localPost: JSON.parse(t.localPostJson) as DeployStep[],
      scriptPath: t.scriptPath ?? undefined,
      healthUrl: t.healthUrl ?? undefined,
      createdAt: t.createdAt.toISOString(),
      lastDeployment: last
        ? {
            id: last.id,
            status: last.status as DeploymentStatus,
            startedAt: last.startedAt.toISOString(),
          }
        : undefined,
    };
  }
}
