import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ScenarioRunResult,
  ScenarioSummary,
  StepRunResult,
  VariableExtraction,
} from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionsService } from '../collections/collections.service';
import { resolveJsonPath } from '../runner/assertion-evaluator';
import { AddStepDto } from './scenarios.dto';

@Injectable()
export class ScenariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collections: CollectionsService,
  ) {}

  async list(projectId: string): Promise<ScenarioSummary[]> {
    const rows = await this.prisma.scenario.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    return rows.map((s) => ({
      id: s.id,
      projectId: s.projectId,
      name: s.name,
      createdAt: s.createdAt.toISOString(),
      steps: s.steps.map((st) => ({
        id: st.id,
        scenarioId: st.scenarioId,
        savedRequestId: st.savedRequestId,
        order: st.order,
        extractions: JSON.parse(st.extractionsJson),
      })),
    }));
  }

  async create(projectId: string, name: string) {
    const row = await this.prisma.scenario.create({ data: { projectId, name } });
    return { id: row.id, projectId, name: row.name, createdAt: row.createdAt.toISOString(), steps: [] };
  }

  async rename(id: string, name: string) {
    await this.ensureScenario(id);
    await this.prisma.scenario.update({ where: { id }, data: { name } });
  }

  async remove(id: string) {
    await this.ensureScenario(id);
    await this.prisma.scenario.delete({ where: { id } });
  }

  async addStep(scenarioId: string, dto: AddStepDto) {
    await this.ensureScenario(scenarioId);
    const last = await this.prisma.scenarioStep.findFirst({
      where: { scenarioId },
      orderBy: { order: 'desc' },
    });
    const row = await this.prisma.scenarioStep.create({
      data: {
        scenarioId,
        savedRequestId: dto.savedRequestId,
        order: (last?.order ?? 0) + 1,
        extractionsJson: JSON.stringify(dto.extractions ?? []),
      },
    });
    return {
      id: row.id,
      scenarioId,
      savedRequestId: row.savedRequestId,
      order: row.order,
      extractions: JSON.parse(row.extractionsJson),
    };
  }

  async removeStep(stepId: string) {
    const row = await this.prisma.scenarioStep.findUnique({ where: { id: stepId } });
    if (!row) throw new NotFoundException(`Step ${stepId} not found`);
    await this.prisma.scenarioStep.delete({ where: { id: stepId } });
  }

  /**
   * Run all steps in order. Response values extracted via dot paths become
   * {{variables}} for subsequent steps. A failed step (network error, HTTP
   * >= 400, or failed assertion) skips the remaining steps.
   */
  async run(scenarioId: string, environmentId?: string): Promise<ScenarioRunResult> {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id: scenarioId },
      include: {
        steps: { orderBy: { order: 'asc' }, include: { savedRequest: true } },
      },
    });
    if (!scenario) throw new NotFoundException(`Scenario ${scenarioId} not found`);

    const runtimeVars: Record<string, string> = {};
    const stepResults: StepRunResult[] = [];
    let failed = false;

    for (const step of scenario.steps) {
      if (failed) {
        stepResults.push({
          stepId: step.id,
          requestId: step.savedRequestId,
          requestName: step.savedRequest.name,
          result: {
            executionId: '',
            url: step.savedRequest.url,
            durationMs: 0,
            responseHeaders: {},
            body: '',
            truncated: false,
          },
          assertions: [],
          extracted: {},
          skipped: true,
        });
        continue;
      }

      const { result, assertions } = await this.collections.runRequest(
        step.savedRequestId,
        environmentId,
        runtimeVars,
      );

      const extracted: Record<string, string> = {};
      const extractions: VariableExtraction[] = JSON.parse(step.extractionsJson);
      if (extractions.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.body);
        } catch {
          parsed = undefined;
        }
        for (const ex of extractions) {
          const value = resolveJsonPath(parsed, ex.pathExpr);
          if (value !== undefined && value !== null) {
            extracted[ex.name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
            runtimeVars[ex.name] = extracted[ex.name];
          }
        }
      }

      const stepFailed =
        !!result.error || (result.status ?? 0) >= 400 || assertions.some((a) => !a.passed);
      if (stepFailed) failed = true;

      stepResults.push({
        stepId: step.id,
        requestId: step.savedRequestId,
        requestName: step.savedRequest.name,
        result,
        assertions,
        extracted,
        skipped: false,
      });
    }

    return { scenarioId, passed: !failed, steps: stepResults };
  }

  private async ensureScenario(id: string) {
    const row = await this.prisma.scenario.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Scenario ${id} not found`);
  }
}
