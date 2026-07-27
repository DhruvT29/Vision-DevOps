import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type {
  DeployTargetSummary,
  DeploymentDetail,
  DeploymentSummary,
  ParsedDeployScript,
  StartDeployResult,
} from '@vision/shared';
import { Observable, map } from 'rxjs';
import { DeployService } from './deploy.service';
import {
  ParseScriptDto,
  RespondDeployDto,
  UpsertDeployTargetDto,
} from './deploy-target.dto';

@Controller()
export class DeployController {
  constructor(private readonly svc: DeployService) {}

  // ── Targets ────────────────────────────────────────────────────────────────

  @Get('projects/:id/deploy-targets')
  listTargets(@Param('id') projectId: string): Promise<DeployTargetSummary[]> {
    return this.svc.listTargets(projectId);
  }

  @Post('projects/:id/deploy-targets')
  createTarget(
    @Param('id') projectId: string,
    @Body() dto: UpsertDeployTargetDto,
  ): Promise<DeployTargetSummary> {
    return this.svc.createTarget(projectId, dto);
  }

  @Patch('deploy-targets/:id')
  updateTarget(
    @Param('id') id: string,
    @Body() dto: UpsertDeployTargetDto,
  ): Promise<DeployTargetSummary> {
    return this.svc.updateTarget(id, dto);
  }

  @Delete('deploy-targets/:id')
  deleteTarget(@Param('id') id: string): Promise<{ ok: true }> {
    return this.svc.deleteTarget(id);
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  @Post('deploy-targets/:id/deploy')
  start(@Param('id') id: string): Promise<StartDeployResult> {
    return this.svc.start(id);
  }

  @Get('deployments/:id')
  detail(@Param('id') id: string): Promise<DeploymentDetail> {
    return this.svc.detail(id);
  }

  @Get('projects/:id/deployments')
  history(
    @Param('id') projectId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<DeploymentSummary[]> {
    return this.svc.history(projectId, Math.min(Math.max(limit, 1), 100));
  }

  @Post('deployments/:id/cancel')
  cancel(@Param('id') id: string): Promise<{ ok: true }> {
    return this.svc.cancel(id);
  }

  @Post('deployments/:id/respond')
  respond(@Param('id') id: string, @Body() dto: RespondDeployDto): Promise<{ ok: true }> {
    return this.svc.respond(id, dto.stepIndex, dto.answer);
  }

  // ── Script import ──────────────────────────────────────────────────────────

  @Post('deploy/parse-script')
  parseScript(@Body() dto: ParseScriptDto): Promise<ParsedDeployScript> {
    return this.svc.parseScript(dto);
  }

  @Sse('deployments/:id/stream')
  stream(@Param('id') id: string): Observable<MessageEvent> {
    return this.svc.stream(id).pipe(map((ev) => ({ data: ev }) as MessageEvent));
  }
}
