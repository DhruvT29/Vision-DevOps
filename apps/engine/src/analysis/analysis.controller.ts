import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import type { GraphPayload, SnapshotSummary } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';

@Controller('snapshots')
export class AnalysisController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async snapshot(@Param('id') id: string): Promise<SnapshotSummary> {
    const snap = await this.prisma.snapshot.findUnique({ where: { id } });
    if (!snap) throw new NotFoundException(`Snapshot ${id} not found`);
    return this.toSummary(snap);
  }

  @Get(':id/graph')
  async graph(@Param('id') id: string): Promise<GraphPayload> {
    const snap = await this.prisma.snapshot.findUnique({
      where: { id },
      include: {
        modules: { include: { endpoints: true }, orderBy: { name: 'asc' } },
        frontendCalls: true,
        edges: true,
      },
    });
    if (!snap) throw new NotFoundException(`Snapshot ${id} not found`);

    return {
      snapshot: this.toSummary(snap),
      modules: snap.modules.map((m) => ({
        id: m.id,
        snapshotId: m.snapshotId,
        name: m.name,
        kind: m.kind as never,
        filePath: m.filePath,
        endpointCount: m.endpoints.length,
      })),
      endpoints: snap.modules.flatMap((m) =>
        m.endpoints.map((e) => ({
          id: e.id,
          moduleId: e.moduleId,
          layer: e.layer as never,
          method: e.method as never,
          fullPath: e.fullPath,
          handlerName: e.handlerName,
          params: JSON.parse(e.paramsJson),
          bodyFields: e.bodyFieldsJson ? JSON.parse(e.bodyFieldsJson) : null,
          bodyTypeName: e.bodyTypeName,
          auth: JSON.parse(e.authJson),
          filePath: e.filePath,
          line: e.line,
        })),
      ),
      frontendCalls: snap.frontendCalls.map((c) => ({
        id: c.id,
        snapshotId: c.snapshotId,
        client: c.client as never,
        method: c.method as never,
        rawUrl: c.rawUrl,
        resolvedPath: c.resolvedPath,
        callerSymbol: c.callerSymbol,
        filePath: c.filePath,
        line: c.line,
      })),
      edges: snap.edges.map((e) => ({
        id: e.id,
        snapshotId: e.snapshotId,
        sourceId: e.sourceId,
        targetId: e.targetId,
        type: e.type as never,
        confidence: e.confidence,
        manual: e.manual,
      })),
    };
  }

  private toSummary(snap: {
    id: string;
    projectId: string;
    status: string;
    createdAt: Date;
    error: string | null;
    statsJson: string | null;
  }): SnapshotSummary {
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
