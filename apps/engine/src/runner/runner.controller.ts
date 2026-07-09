import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import type { ExecutionSummary, RunResult } from '@vision/shared';
import { RunRequestDto } from './run-request.dto';
import { RunnerService } from './runner.service';

@Controller()
export class RunnerController {
  constructor(private readonly svc: RunnerService) {}

  @Post('run')
  run(@Body() dto: RunRequestDto): Promise<RunResult> {
    return this.svc.run(dto);
  }

  @Get('projects/:projectId/executions')
  history(
    @Param('projectId') projectId: string,
    @Query('endpointId') endpointId?: string,
    @Query('limit') limit?: string,
  ): Promise<ExecutionSummary[]> {
    return this.svc.history(projectId, endpointId, limit ? Number(limit) : undefined);
  }

  @Get('executions/:id')
  async execution(@Param('id') id: string) {
    const row = await this.svc.execution(id);
    if (!row) throw new NotFoundException(`Execution ${id} not found`);
    return {
      id: row.id,
      method: row.method,
      url: row.url,
      status: row.status ?? undefined,
      durationMs: row.durationMs,
      requestHeaders: JSON.parse(row.requestHeadersJson),
      requestBody: row.requestBody,
      responseHeaders: JSON.parse(row.responseHeadersJson),
      responseBody: row.responseBody,
      truncated: row.truncated,
      error: row.error ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
