import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import * as path from 'path';
import type {
  DbDiffResult,
  DbEntityNode,
  DbSchemaResult,
  DiffImpactResult,
  GraphEdge,
  GraphPayload,
  InsightsPayload,
  SnapshotSummary,
} from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { InsightsService } from './insights.service';
import { DiffImpactDto } from './diff-impact.dto';
import { DbDiffDto } from './db-diff.dto';

/** Builds a github.com blob link from an absolute clone-dir path, if possible. */
function blobUrl(
  project: { source: string; repoUrl: string | null; repoBranch: string | null; rootPath: string },
  filePath: string,
  line: number,
): string | undefined {
  if (project.source !== 'github' || !project.repoUrl || !project.repoBranch) return undefined;
  const rel = path.relative(project.rootPath, filePath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return undefined;
  return `${project.repoUrl}/blob/${project.repoBranch}/${rel}#L${line}`;
}

@Controller('snapshots')
export class AnalysisController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly insights: InsightsService,
  ) {}

  @Get(':id')
  async snapshot(@Param('id') id: string): Promise<SnapshotSummary> {
    const snap = await this.prisma.snapshot.findUnique({ where: { id } });
    if (!snap) throw new NotFoundException(`Snapshot ${id} not found`);
    return this.toSummary(snap);
  }

  @Get(':id/insights')
  insightsFor(@Param('id') id: string): Promise<InsightsPayload> {
    return this.insights.insights(id);
  }

  @Post(':id/diff-impact')
  diffImpact(@Param('id') id: string, @Body() dto: DiffImpactDto): Promise<DiffImpactResult> {
    return this.insights.diffImpact(id, dto.base);
  }

  @Get(':id/migration-files')
  migrationFiles(@Param('id') id: string): Promise<string[]> {
    return this.insights.migrationFiles(id);
  }

  @Post(':id/db-diff')
  dbDiff(@Param('id') id: string, @Body() dto: DbDiffDto): Promise<DbDiffResult> {
    return this.insights.dbDiff(id, dto);
  }

  @Get(':id/graph')
  async graph(@Param('id') id: string): Promise<GraphPayload> {
    const snap = await this.prisma.snapshot.findUnique({
      where: { id },
      include: {
        modules: { include: { endpoints: true }, orderBy: { name: 'asc' } },
        frontendCalls: true,
        edges: true,
        entities: { orderBy: { tableName: 'asc' } },
      },
    });
    if (!snap) throw new NotFoundException(`Snapshot ${id} not found`);

    // github projects link source lines back to github.com
    const project = await this.prisma.project.findUnique({ where: { id: snap.projectId } });

    const edges: GraphEdge[] = snap.edges.map((e) => ({
      id: e.id,
      snapshotId: e.snapshotId,
      sourceId: e.sourceId,
      targetId: e.targetId,
      type: e.type as never,
      confidence: e.confidence,
      manual: e.manual,
      meta: e.metaJson ? JSON.parse(e.metaJson) : undefined,
    }));
    const entities: DbEntityNode[] = snap.entities.map((e) => ({
      id: e.id,
      snapshotId: e.snapshotId,
      name: e.name,
      tableName: e.tableName,
      filePath: e.filePath,
      line: e.line,
      moduleId: e.moduleId,
      columns: JSON.parse(e.columnsJson),
      sourceUrl: project ? blobUrl(project, e.filePath, e.line) : undefined,
    }));

    // overlay the real DB's foreign keys when a schema has been fetched
    await this.mergeRealDbForeignKeys(snap.projectId, entities, edges);

    return {
      snapshot: this.toSummary(snap),
      modules: snap.modules.map((m) => ({
        id: m.id,
        snapshotId: m.snapshotId,
        name: m.name,
        kind: m.kind as never,
        filePath: m.filePath,
        endpointCount: m.endpoints.length,
        isGlobal: m.isGlobal,
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
          sourceUrl: project ? blobUrl(project, e.filePath, e.line) : undefined,
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
        sourceUrl: project ? blobUrl(project, c.filePath, c.line) : undefined,
      })),
      edges,
      entities,
    };
  }

  /**
   * Overlay the real database's foreign keys onto the code-derived graph. If any
   * of the project's deploy targets has a fetched schema cached, its FK
   * constraints are authoritative: they light up FK columns, stamp real primary
   * keys, and add `origin:'db'` edges for relations the source code never
   * declared. A no-op when no schema has been fetched. Read-only — never a rescan.
   */
  private async mergeRealDbForeignKeys(
    projectId: string,
    entities: DbEntityNode[],
    edges: GraphEdge[],
  ): Promise<void> {
    const cache = await this.prisma.dbSchemaCache.findFirst({
      where: { target: { projectId } },
      orderBy: { fetchedAt: 'desc' },
    });
    if (!cache) return;

    let schema: DbSchemaResult;
    try {
      schema = JSON.parse(cache.schemaJson);
    } catch {
      return;
    }

    // normalized table name → entity (lowercased/stripped, plus de-pluralized)
    const variants = (s: string): string[] => {
      const base = s.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!base) return [];
      const out = new Set([base]);
      if (/ies$/.test(base)) out.add(base.slice(0, -3) + 'y');
      else if (/(ses|xes|zes|ches|shes)$/.test(base)) out.add(base.slice(0, -2));
      else if (/s$/.test(base) && !/ss$/.test(base)) out.add(base.slice(0, -1));
      return [...out];
    };
    const index = new Map<string, DbEntityNode>();
    for (const ent of entities) {
      for (const key of [...variants(ent.tableName), ...variants(ent.name)]) {
        if (!index.has(key)) index.set(key, ent);
      }
    }
    const resolve = (table: string): DbEntityNode | undefined => {
      for (const key of variants(table)) {
        const ent = index.get(key);
        if (ent) return ent;
      }
      return undefined;
    };
    const markColumn = (ent: DbEntityNode, colName: string, patch: Partial<DbEntityNode['columns'][number]>) => {
      const lc = colName.toLowerCase();
      const col =
        ent.columns.find((c) => c.name === colName) ??
        ent.columns.find((c) => c.name.toLowerCase() === lc);
      if (col) Object.assign(col, patch);
    };

    const existing = new Set(
      edges.filter((e) => e.type === 'fk').map((e) => `${e.sourceId}->${e.targetId}`),
    );
    let synthetic = 0;
    for (const table of schema.tables) {
      const src = resolve(table.name);
      if (!src) continue;
      for (const pk of table.primaryKey ?? []) markColumn(src, pk, { isPrimaryKey: true });
      for (const fk of table.foreignKeys ?? []) {
        const tgt = resolve(fk.refTable);
        markColumn(src, fk.column, {
          isForeignKey: true,
          refTable: tgt?.tableName ?? fk.refTable,
        });
        if (!tgt || tgt.id === src.id) continue;
        const key = `${src.id}->${tgt.id}`;
        if (existing.has(key)) continue;
        existing.add(key);
        edges.push({
          id: `db-fk:${key}:${synthetic++}`,
          snapshotId: src.snapshotId,
          sourceId: src.id,
          targetId: tgt.id,
          type: 'fk',
          confidence: 1,
          manual: false,
          meta: { properties: [fk.column], origin: 'db' },
        });
      }
    }
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
