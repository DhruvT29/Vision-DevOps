import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { OpenProjectResponse, ProjectBranchesResult, ProjectSummary } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ScannerService } from '../analysis/scanner.service';
import { StackDetectorService } from '../analysis/stack-detector.service';
import { GithubSourceService, NoRepoAccessError } from './github-source.service';
import { OpenGithubDto } from './open-github.dto';

interface GithubMeta {
  source: 'github';
  repoUrl: string;
  repoCloneUrl: string;
  repoBranch: string;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly detector: StackDetectorService,
    private readonly scanner: ScannerService,
    private readonly github: GithubSourceService,
  ) {}

  /** Clone a GitHub repo (reusing system credentials) then analyze it like a local dir. */
  async openGithub(dto: OpenGithubDto): Promise<OpenProjectResponse> {
    let resolved: Awaited<ReturnType<GithubSourceService['resolve']>>;
    try {
      resolved = await this.github.resolve(dto);
    } catch (e) {
      if (e instanceof NoRepoAccessError) {
        throw new ForbiddenException({
          message: 'Ask owner to grant access to you',
          triedAccounts: e.triedAccounts,
        });
      }
      throw e;
    }
    return this.open(resolved.rootPath, {
      source: 'github',
      repoUrl: resolved.repoUrl,
      repoCloneUrl: resolved.cloneUrl,
      repoBranch: resolved.branch,
    });
  }

  /**
   * Remove a project from history. Cascades to its snapshots, environments,
   * collections and scenarios in the DB; never touches the source directory
   * or a cached GitHub clone (re-opening reuses the cache).
   */
  async remove(id: string): Promise<{ ok: true }> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    await this.prisma.project.delete({ where: { id } });
    return { ok: true };
  }

  async open(rootPath: string, meta?: GithubMeta): Promise<OpenProjectResponse> {
    const normalized = path.resolve(rootPath);
    if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
      throw new BadRequestException(`Not a directory: ${normalized}`);
    }

    const stacks = this.detector.detect(normalized);
    if (stacks.length === 0) {
      throw new BadRequestException(
        `No Node.js apps found under ${normalized} (no package.json within 3 levels)`,
      );
    }

    const project = meta
      ? await this.upsertGithubProject(normalized, meta, JSON.stringify(stacks))
      : await this.prisma.project.upsert({
          where: { rootPath: normalized },
          create: {
            name: path.basename(normalized),
            rootPath: normalized,
            detectedStacksJson: JSON.stringify(stacks),
          },
          update: {
            lastOpenedAt: new Date(),
            detectedStacksJson: JSON.stringify(stacks),
          },
        });

    const snapshot = await this.prisma.snapshot.create({
      data: { projectId: project.id },
    });

    this.scanner.runInBackground(snapshot.id, normalized, stacks);

    return {
      project: this.toSummary(project),
      snapshot: {
        id: snapshot.id,
        projectId: project.id,
        status: 'pending',
        createdAt: snapshot.createdAt.toISOString(),
      },
    };
  }

  /**
   * One Project per repo: the canonical row is matched by repoUrl and moved to
   * the new branch's clone dir in place, so branch switches keep the same
   * project id — deploy targets, collections and environments carry across
   * branches. A distinct row already owning the clone dir is a stale sibling
   * from the old one-project-per-branch model and gets absorbed.
   */
  private async upsertGithubProject(rootPath: string, meta: GithubMeta, stacksJson: string) {
    const pathOwner = await this.prisma.project.findUnique({ where: { rootPath } });
    const canonical =
      (await this.prisma.project.findFirst({
        where: { repoUrl: meta.repoUrl },
        orderBy: { lastOpenedAt: 'desc' },
      })) ?? pathOwner;
    if (pathOwner && pathOwner.id !== canonical!.id) {
      await this.prisma.project.delete({ where: { id: pathOwner.id } });
    }

    const data = {
      rootPath,
      lastOpenedAt: new Date(),
      detectedStacksJson: stacksJson,
      source: meta.source,
      repoUrl: meta.repoUrl,
      repoCloneUrl: meta.repoCloneUrl,
      repoBranch: meta.repoBranch,
    };
    if (canonical) {
      return this.prisma.project.update({ where: { id: canonical.id }, data });
    }
    return this.prisma.project.create({
      data: { name: this.repoName(meta.repoUrl), ...data },
    });
  }

  /** Remote branch list for an opened GitHub project (for the branch switcher). */
  async branches(id: string): Promise<ProjectBranchesResult> {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    if (project.source !== 'github' || !project.repoUrl) {
      throw new BadRequestException('Branches are only available for projects opened from GitHub');
    }
    const pre = await this.github.preflight({ repoUrl: project.repoUrl });
    if (!pre.access) {
      throw new ForbiddenException({
        message: 'Ask owner to grant access to you',
        triedAccounts: pre.triedAccounts,
      });
    }
    return {
      current: project.repoBranch ?? undefined,
      defaultBranch: pre.defaultBranch,
      branches: pre.branches,
    };
  }

  async list(): Promise<ProjectSummary[]> {
    const projects = await this.prisma.project.findMany({
      orderBy: { lastOpenedAt: 'desc' },
    });
    return projects.map((p) => this.toSummary(p));
  }

  /** Latest completed (or otherwise most recent) snapshot for a project. */
  async latestSnapshot(projectId: string) {
    return (
      (await this.prisma.snapshot.findFirst({
        where: { projectId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.snapshot.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      }))
    );
  }

  /** "owner/repo" from a canonical https github url, for the project name. */
  private repoName(repoUrl: string): string {
    return repoUrl.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  }

  private toSummary(p: {
    id: string;
    name: string;
    rootPath: string;
    detectedStacksJson: string;
    source: string;
    repoUrl: string | null;
    repoCloneUrl: string | null;
    repoBranch: string | null;
    lastOpenedAt: Date;
    createdAt: Date;
  }): ProjectSummary {
    return {
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      detectedStacks: JSON.parse(p.detectedStacksJson),
      source: p.source === 'github' ? 'github' : 'local',
      repoUrl: p.repoUrl ?? undefined,
      repoCloneUrl: p.repoCloneUrl ?? undefined,
      repoBranch: p.repoBranch ?? undefined,
      lastOpenedAt: p.lastOpenedAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
    };
  }
}
