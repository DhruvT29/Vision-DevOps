import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import type { OpenProjectResponse, ProjectSummary, SnapshotSummary } from '@vision/shared';
import { OpenProjectDto } from './open-project.dto';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly svc: ProjectsService) {}

  @Post('open')
  open(@Body() dto: OpenProjectDto): Promise<OpenProjectResponse> {
    return this.svc.open(dto.rootPath);
  }

  @Get()
  list(): Promise<ProjectSummary[]> {
    return this.svc.list();
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
