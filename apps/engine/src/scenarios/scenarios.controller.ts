import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { RenameDto } from '../collections/collections.dto';
import { AddStepDto, CreateScenarioDto, RunScenarioDto } from './scenarios.dto';
import { ScenariosService } from './scenarios.service';

@Controller()
export class ScenariosController {
  constructor(private readonly svc: ScenariosService) {}

  @Get('projects/:projectId/scenarios')
  list(@Param('projectId') projectId: string) {
    return this.svc.list(projectId);
  }

  @Post('projects/:projectId/scenarios')
  create(@Param('projectId') projectId: string, @Body() dto: CreateScenarioDto) {
    return this.svc.create(projectId, dto.name);
  }

  @Patch('scenarios/:id')
  rename(@Param('id') id: string, @Body() dto: RenameDto) {
    return this.svc.rename(id, dto.name);
  }

  @Delete('scenarios/:id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post('scenarios/:id/steps')
  addStep(@Param('id') scenarioId: string, @Body() dto: AddStepDto) {
    return this.svc.addStep(scenarioId, dto);
  }

  @Delete('scenario-steps/:id')
  @HttpCode(204)
  removeStep(@Param('id') id: string) {
    return this.svc.removeStep(id);
  }

  @Post('scenarios/:id/run')
  run(@Param('id') id: string, @Body() dto: RunScenarioDto) {
    return this.svc.run(id, dto.environmentId);
  }
}
