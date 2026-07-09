import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import type { DetectedStack, SnapshotStats } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { NestExtractorService } from './nest-extractor.service';

/**
 * Orchestrates a scan for one snapshot: run extractors per detected stack,
 * persist the resulting graph, update snapshot status. Runs fire-and-forget —
 * callers poll GET /snapshots/:id.
 */
@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nestExtractor: NestExtractorService,
  ) {}

  /** Kick off a scan without awaiting it. */
  runInBackground(snapshotId: string, rootPath: string, stacks: DetectedStack[]) {
    void this.run(snapshotId, rootPath, stacks).catch(async (err) => {
      this.logger.error(`Scan ${snapshotId} failed: ${err?.stack ?? err}`);
      await this.prisma.snapshot.update({
        where: { id: snapshotId },
        data: { status: 'failed', error: String(err?.message ?? err) },
      });
    });
  }

  private async run(snapshotId: string, rootPath: string, stacks: DetectedStack[]) {
    const started = Date.now();
    await this.prisma.snapshot.update({
      where: { id: snapshotId },
      data: { status: 'running' },
    });

    let moduleCount = 0;
    let endpointCount = 0;

    for (const stack of stacks) {
      if (stack.kind !== 'nest') continue; // next/react extractors land in Phase 5
      const stackDir = path.resolve(rootPath, stack.dir);
      const extraction = this.nestExtractor.extract(stackDir);

      // controller class name → module
      const controllerToModule = new Map<string, string>();
      for (const mod of extraction.modules) {
        for (const ctrl of mod.controllerClassNames) controllerToModule.set(ctrl, mod.name);
      }

      // moduleName → its extraction (create DB rows lazily, only for modules
      // that actually own controllers, plus a fallback bucket)
      const moduleRowIds = new Map<string, string>();
      const moduleRowFor = async (name: string, filePath: string) => {
        let id = moduleRowIds.get(name);
        if (!id) {
          const row = await this.prisma.moduleNode.create({
            data: { snapshotId, name, kind: 'nest-module', filePath },
          });
          id = row.id;
          moduleRowIds.set(name, id);
          moduleCount++;
        }
        return id;
      };

      const moduleFileByName = new Map(
        extraction.modules.map((m) => [m.name, m.filePath] as const),
      );

      for (const controller of extraction.controllers) {
        const moduleName = controllerToModule.get(controller.className) ?? '(unassigned)';
        const moduleFile = moduleFileByName.get(moduleName) ?? controller.filePath;
        const moduleId = await moduleRowFor(moduleName, moduleFile);

        for (const ep of controller.endpoints) {
          await this.prisma.endpoint.create({
            data: {
              moduleId,
              layer: 'nest',
              method: ep.method,
              fullPath: ep.fullPath,
              handlerName: ep.handlerName,
              paramsJson: JSON.stringify(ep.params),
              bodyFieldsJson: ep.bodyFields ? JSON.stringify(ep.bodyFields) : null,
              bodyTypeName: ep.bodyTypeName,
              authJson: JSON.stringify(ep.auth),
              filePath: ep.filePath,
              line: ep.line,
            },
          });
          endpointCount++;
        }
      }
    }

    const stats: SnapshotStats = {
      modules: moduleCount,
      endpoints: endpointCount,
      frontendCalls: 0,
      edges: 0,
      durationMs: Date.now() - started,
    };

    await this.prisma.snapshot.update({
      where: { id: snapshotId },
      data: { status: 'completed', statsJson: JSON.stringify(stats) },
    });
    this.logger.log(
      `Scan ${snapshotId} completed: ${moduleCount} modules, ${endpointCount} endpoints in ${stats.durationMs}ms`,
    );
  }
}
