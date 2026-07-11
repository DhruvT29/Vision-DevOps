import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { execFile } from 'child_process';
import * as path from 'path';
import type {
  ChangedFile,
  ContributorStat,
  DiffImpactResult,
  InsightsPayload,
} from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
const MAX_COMMITS = 500; // history window for churn/ownership
const DEEPEN_DEPTH = 300; // shallow github clones get this much history

interface ModuleRow {
  id: string;
  name: string;
  filePath: string;
}

/**
 * Git-derived insights (churn, ownership) and diff→module impact mapping.
 * Read-only over the project's git history; never mutates the working tree.
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Churn & ownership ──────────────────────────────────────────────────────

  async insights(snapshotId: string): Promise<InsightsPayload> {
    const { snap, project } = await this.load(snapshotId);

    const payload: InsightsPayload = {
      snapshotId,
      git: { available: false, commitsAnalyzed: 0 },
      contributors: [],
      modules: snap.modules.map((m) => ({
        moduleId: m.id,
        name: m.name,
        commits: 0,
        contributors: [],
      })),
    };

    let gitTop: string;
    try {
      gitTop = (await this.git(project.rootPath, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      payload.git.reason = 'not a git repository';
      return payload;
    }

    // shallow github clones carry no history — deepen once, best effort
    try {
      const shallow = (
        await this.git(project.rootPath, ['rev-parse', '--is-shallow-repository'])
      ).trim();
      if (shallow === 'true' && project.source === 'github') {
        await this.git(
          project.rootPath,
          ['fetch', `--depth=${DEEPEN_DEPTH}`, 'origin', project.repoBranch ?? 'HEAD'],
          180_000,
        );
        payload.git.deepened = true;
      }
    } catch (e) {
      this.logger.warn(`History deepen failed (continuing with available history): ${e}`);
    }

    let log: string;
    try {
      log = await this.git(
        project.rootPath,
        [
          'log',
          '-n',
          String(MAX_COMMITS),
          '--date-order',
          '--pretty=format:@C%x09%an%x09%aI',
          '--name-only',
          '--',
          '.',
        ],
        120_000,
      );
    } catch (e) {
      payload.git.reason = `git log failed: ${e instanceof Error ? e.message : e}`;
      return payload;
    }

    const owner = this.ownerResolver(snap.modules);
    const perModule = new Map<
      string,
      { commits: number; last?: string; authors: Map<string, number> }
    >();
    const repoAuthors = new Map<string, number>();
    let commitsAnalyzed = 0;

    let author = '';
    let date = '';
    let touched: Set<string> | null = null; // moduleIds touched by current commit
    const flush = () => {
      if (!touched) return;
      commitsAnalyzed++;
      repoAuthors.set(author, (repoAuthors.get(author) ?? 0) + 1);
      for (const moduleId of touched) {
        let entry = perModule.get(moduleId);
        if (!entry) perModule.set(moduleId, (entry = { commits: 0, authors: new Map() }));
        entry.commits++;
        entry.authors.set(author, (entry.authors.get(author) ?? 0) + 1);
        if (!entry.last) entry.last = date; // log is newest-first
      }
      touched = null;
    };

    for (const line of log.split('\n')) {
      if (line.startsWith('@C\t')) {
        flush();
        const [, an, aI] = line.split('\t');
        author = an ?? 'unknown';
        date = aI ?? '';
        touched = new Set();
      } else if (line.trim() && touched) {
        // --name-only paths are repo-root relative
        const mod = owner(path.join(gitTop, line.trim()));
        if (mod) touched.add(mod.id);
      }
    }
    flush();

    payload.git.available = true;
    payload.git.commitsAnalyzed = commitsAnalyzed;
    payload.contributors = this.topContributors(repoAuthors, 10);
    payload.modules = snap.modules
      .map((m) => {
        const entry = perModule.get(m.id);
        return {
          moduleId: m.id,
          name: m.name,
          commits: entry?.commits ?? 0,
          lastCommitAt: entry?.last,
          contributors: entry ? this.topContributors(entry.authors, 3) : [],
        };
      })
      .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
    return payload;
  }

  // ── Diff → module impact ───────────────────────────────────────────────────

  async diffImpact(snapshotId: string, baseInput?: string): Promise<DiffImpactResult> {
    const { snap, project } = await this.load(snapshotId);
    const base = (baseInput ?? '').trim() || 'HEAD';
    if (base.startsWith('-')) throw new BadRequestException('Invalid base ref');

    let gitTop: string;
    try {
      gitTop = (await this.git(project.rootPath, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new BadRequestException('Project is not a git repository');
    }

    const resolvedBase = await this.resolveRef(project, base);

    // committed + uncommitted changes vs base, plus untracked files
    const [nameStatus, untracked] = await Promise.all([
      this.git(project.rootPath, ['diff', '--name-status', '-M', resolvedBase, '--', '.']),
      this.git(project.rootPath, ['ls-files', '--others', '--exclude-standard', '--', '.']),
    ]);

    const entries: { status: string; repoRel: string }[] = [];
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0]?.charAt(0) ?? 'M';
      const repoRel = parts[parts.length - 1]; // renames list old\tnew — take new
      if (repoRel) entries.push({ status, repoRel });
    }
    // ls-files prints cwd-relative paths
    for (const line of untracked.split('\n')) {
      if (line.trim()) {
        entries.push({
          status: 'A',
          repoRel: path.relative(gitTop, path.resolve(project.rootPath, line.trim())),
        });
      }
    }

    const owner = this.ownerResolver(snap.modules);
    const changedFiles: ChangedFile[] = [];
    for (const { status, repoRel } of entries) {
      const abs = path.join(gitTop, repoRel);
      const rel = path.relative(project.rootPath, abs).replace(/\\/g, '/');
      if (rel.startsWith('..')) continue;
      const mod = owner(abs);
      changedFiles.push({
        path: rel,
        status,
        moduleId: mod?.id ?? null,
        moduleName: mod?.name ?? null,
      });
    }
    changedFiles.sort((a, b) => a.path.localeCompare(b.path));

    const moduleIds = [
      ...new Set(changedFiles.map((f) => f.moduleId).filter((id): id is string => !!id)),
    ];
    return { base: resolvedBase, changedFiles, moduleIds };
  }

  /** Resolve a user-supplied ref; for github clones try fetching it first. */
  private async resolveRef(
    project: { rootPath: string; source: string },
    base: string,
  ): Promise<string> {
    const canResolve = async (ref: string) => {
      try {
        await this.git(project.rootPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    };
    if (await canResolve(base)) return base;
    if (await canResolve(`origin/${base}`)) return `origin/${base}`;
    if (project.source === 'github') {
      try {
        await this.git(
          project.rootPath,
          ['fetch', `--depth=${DEEPEN_DEPTH}`, 'origin', base],
          180_000,
        );
        if (await canResolve('FETCH_HEAD')) return 'FETCH_HEAD';
      } catch {
        /* fall through to the error below */
      }
    }
    throw new BadRequestException(`Unknown git ref: ${base}`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async load(snapshotId: string) {
    const snap = await this.prisma.snapshot.findUnique({
      where: { id: snapshotId },
      include: { modules: true },
    });
    if (!snap) throw new NotFoundException(`Snapshot ${snapshotId} not found`);
    const project = await this.prisma.project.findUnique({ where: { id: snap.projectId } });
    if (!project) throw new NotFoundException(`Project ${snap.projectId} not found`);
    return { snap, project };
  }

  /**
   * Absolute file path → owning module. A module owns its directory subtree,
   * deepest dir winning. A module whose dir contains another module's dir
   * (e.g. AppModule at the src root) only owns its own defining file, so
   * shared root-level folders don't smear into it.
   */
  private ownerResolver(modules: ModuleRow[]) {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const byFile = new Map(modules.map((m) => [norm(m.filePath), m]));
    const dirs = modules.map((m) => ({ m, dir: norm(path.dirname(m.filePath)) }));
    const containerIds = new Set(
      dirs
        .filter((a) => dirs.some((b) => b.m.id !== a.m.id && b.dir.startsWith(a.dir + '/')))
        .map((a) => a.m.id),
    );
    const owners = dirs
      .filter((d) => !containerIds.has(d.m.id))
      .sort((a, b) => b.dir.length - a.dir.length);

    return (absPath: string): ModuleRow | null => {
      const p = norm(absPath);
      const exact = byFile.get(p);
      if (exact) return exact;
      return owners.find((o) => p.startsWith(o.dir + '/'))?.m ?? null;
    };
  }

  private topContributors(authors: Map<string, number>, limit: number): ContributorStat[] {
    return [...authors]
      .map(([name, commits]) => ({ name, commits }))
      .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  private git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', cwd, ...args],
        { env: GIT_ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err)

            reject(
              new Error(
                `git ${args[0]} failed: ${String(stderr || err.message)
                  .replace(/\s+/g, ' ')
                  .slice(0, 300)}`,
              ),
            );
          else resolve(stdout);
        },
      );
    });
  }
}
