import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { EnvironmentSummary } from '@vision/shared';
import { UpsertEnvironmentDto } from './environment.dto';
import { EnvironmentsService } from './environments.service';

@Controller()
export class EnvironmentsController {
  constructor(private readonly svc: EnvironmentsService) {}

  @Get('projects/:projectId/environments')
  list(@Param('projectId') projectId: string): Promise<EnvironmentSummary[]> {
    return this.svc.list(projectId);
  }

  @Post('projects/:projectId/environments')
  create(
    @Param('projectId') projectId: string,
    @Body() dto: UpsertEnvironmentDto,
  ): Promise<EnvironmentSummary> {
    return this.svc.create(projectId, dto);
  }

  @Patch('environments/:id')
  update(@Param('id') id: string, @Body() dto: UpsertEnvironmentDto): Promise<EnvironmentSummary> {
    return this.svc.update(id, dto);
  }

  @Delete('environments/:id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.svc.remove(id);
  }
}
