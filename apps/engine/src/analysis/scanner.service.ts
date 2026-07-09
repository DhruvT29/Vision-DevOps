import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import type { DetectedStack, SnapshotStats } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { NestExtractorService } from './nest-extractor.service';
import { NextExtractorService } from './next-extractor.service';
import { FrontendExtractorService } from './frontend-extractor.service';
import { linkCallsToEndpoints } from './linker';

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
    private readonly nextExtractor: NextExtractorService,
    private readonly frontendExtractor: FrontendExtractorService,
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
    let frontendCallCount = 0;
    let edgeCount = 0;

    // endpoint rows created this scan, for the cross-layer linker
    const createdEndpoints: { id: string; method: string; fullPath: string }[] = [];
    const createdCalls: { id: string; method: string; resolvedPath: string | null }[] = [];

    for (const stack of stacks) {
      const stackDir = path.resolve(rootPath, stack.dir);

      // React/Next frontends: collect HTTP call sites
      if (stack.kind === 'react' || stack.kind === 'next') {
        const calls = this.frontendExtractor.extract(stackDir);
        for (const call of calls) {
          const row = await this.prisma.frontendCall.create({
            data: {
              snapshotId,
              client: call.client,
              method: call.method,
              rawUrl: call.rawUrl,
              resolvedPath: call.resolvedPath,
              callerSymbol: call.callerSymbol,
              filePath: call.filePath,
              line: call.line,
            },
          });
          createdCalls.push({ id: row.id, method: call.method, resolvedPath: call.resolvedPath });
          frontendCallCount++;
        }
      }

      const extraction =
        stack.kind === 'nest'
          ? this.nestExtractor.extract(stackDir)
          : stack.kind === 'next'
            ? { globalPrefix: null, ...this.nextExtractor.extract(stackDir) }
            : null;
      if (!extraction) continue;
      const layer = stack.kind === 'nest' ? 'nest' : 'next-api';
      const moduleKind = stack.kind === 'nest' ? 'nest-module' : 'next-api-group';

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
            data: { snapshotId, name, kind: moduleKind, filePath },
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
          const row = await this.prisma.endpoint.create({
            data: {
              moduleId,
              layer,
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
          createdEndpoints.push({ id: row.id, method: ep.method, fullPath: ep.fullPath });
          endpointCount++;
        }
      }
    }

    // Cross-layer linking: frontend call sites → backend endpoints
    const links = linkCallsToEndpoints(createdCalls, createdEndpoints);
    for (const link of links) {
      await this.prisma.graphEdge.create({
        data: {
          snapshotId,
          sourceId: link.sourceId,
          targetId: link.targetId,
          type: 'calls',
          confidence: link.confidence,
        },
      });
      edgeCount++;
    }

    const stats: SnapshotStats = {
      modules: moduleCount,
      endpoints: endpointCount,
      frontendCalls: frontendCallCount,
      edges: edgeCount,
      durationMs: Date.now() - started,
    };

    await this.prisma.snapshot.update({
      where: { id: snapshotId },
      data: { status: 'completed', statsJson: JSON.stringify(stats) },
    });
    this.logger.log(
      `Scan ${snapshotId} completed: ${moduleCount} modules, ${endpointCount} endpoints, ` +
        `${frontendCallCount} frontend calls, ${edgeCount} call edges in ${stats.durationMs}ms`,
    );
  }
}
