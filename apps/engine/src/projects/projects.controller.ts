import { Body, Controller, Delete, Get, NotFoundException, Param, Post } from '@nestjs/common';
import type {
  GithubPreflightResult,
  OpenProjectResponse,
  ProjectSummary,
  SnapshotSummary,
} from '@vision/shared';
import { OpenProjectDto } from './open-project.dto';
import { OpenGithubDto } from './open-github.dto';
import { GithubPreflightDto } from './github-preflight.dto';
import { GithubSourceService } from './github-source.service';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly svc: ProjectsService,
    private readonly github: GithubSourceService,
  ) {}

  @Post('open')
  open(@Body() dto: OpenProjectDto): Promise<OpenProjectResponse> {
    return this.svc.open(dto.rootPath);
  }

  @Post('open-github')
  openGithub(@Body() dto: OpenGithubDto): Promise<OpenProjectResponse> {
    return this.svc.openGithub(dto);
  }

  @Post('github-preflight')
  preflight(@Body() dto: GithubPreflightDto): Promise<GithubPreflightResult> {
    return this.github.preflight(dto);
  }

  @Get()
  list(): Promise<ProjectSummary[]> {
    return this.svc.list();
  }

  @Delete(':id')
  remove(@Param('id') id: string): Promise<{ ok: true }> {
    return this.svc.remove(id);
  }

  @Get(':id/latest-snapshot')
  async latestSnapshot(@Param('id') id: string): Promise<SnapshotSummary> {
    const snap = await this.svc.latestSnapshot(id);
    if (!snap) throw new NotFoundException(`No snapshots for project ${id}`);
    return {
      id: snap.id,
      projectId: snap.projectId,
      status: snap.status as never,
      createdAt: snap.createdAt.toISOString(),
      error: snap.error ?? undefined,
      stats: snap.statsJson ? JSON.parse(snap.statsJson) : undefined,
    };
  }
}
