import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssertionSpec,
  CollectionsPayload,
  RunSavedRequestResult,
  SavedRequestSummary,
} from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerService } from '../runner/runner.service';
import { evaluateAssertions } from '../runner/assertion-evaluator';
import { CreateCollectionDto, UpsertSavedRequestDto } from './collections.dto';

type RequestRow = {
  id: string;
  collectionId: string;
  name: string;
  endpointId: string | null;
  method: string;
  url: string;
  headersJson: string;
  body: string | null;
  createdAt: Date;
  updatedAt: Date;
  assertions: { id: string; type: string; pathExpr: string | null; operator: string; expected: string | null }[];
};

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: RunnerService,
  ) {}

  async payload(projectId: string): Promise<CollectionsPayload> {
    const collections = await this.prisma.collection.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: { requests: { include: { assertions: true }, orderBy: { createdAt: 'asc' } } },
    });
    return {
      collections: collections.map((c) => ({
        id: c.id,
        projectId: c.projectId,
        parentId: c.parentId,
        name: c.name,
        createdAt: c.createdAt.toISOString(),
      })),
      requests: collections.flatMap((c) => c.requests.map((r) => this.toRequestSummary(r))),
    };
  }

  async createCollection(projectId: string, dto: CreateCollectionDto) {
    const row = await this.prisma.collection.create({
      data: { projectId, name: dto.name, parentId: dto.parentId },
    });
    return {
      id: row.id,
      projectId: row.projectId,
      parentId: row.parentId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async renameCollection(id: string, name: string) {
    await this.ensure(this.prisma.collection, id, 'Collection');
    await this.prisma.collection.update({ where: { id }, data: { name } });
  }

  async deleteCollection(id: string) {
    await this.ensure(this.prisma.collection, id, 'Collection');
    // reparent children to root rather than cascading a whole subtree away
    await this.prisma.collection.updateMany({ where: { parentId: id }, data: { parentId: null } });
    await this.prisma.collection.delete({ where: { id } });
  }

  async createRequest(collectionId: string, dto: UpsertSavedRequestDto): Promise<SavedRequestSummary> {
    await this.ensure(this.prisma.collection, collectionId, 'Collection');
    const row = await this.prisma.savedRequest.create({
      data: {
        collectionId,
        name: dto.name,
        endpointId: dto.endpointId,
        method: dto.method,
        url: dto.url,
        headersJson: JSON.stringify(dto.headers ?? {}),
        body: dto.body ?? null,
        assertions: {
          create: (dto.assertions ?? []).map((a) => this.toAssertionRow(a)),
        },
      },
      include: { assertions: true },
    });
    return this.toRequestSummary(row);
  }

  async updateRequest(id: string, dto: UpsertSavedRequestDto): Promise<SavedRequestSummary> {
    await this.ensure(this.prisma.savedRequest, id, 'Request');
    const row = await this.prisma.savedRequest.update({
      where: { id },
      data: {
        name: dto.name,
        endpointId: dto.endpointId,
        method: dto.method,
        url: dto.url,
        headersJson: JSON.stringify(dto.headers ?? {}),
        body: dto.body ?? null,
        assertions: {
          deleteMany: {},
          create: (dto.assertions ?? []).map((a) => this.toAssertionRow(a)),
        },
      },
      include: { assertions: true },
    });
    return this.toRequestSummary(row);
  }

  async deleteRequest(id: string) {
    await this.ensure(this.prisma.savedRequest, id, 'Request');
    await this.prisma.savedRequest.delete({ where: { id } });
  }

  /** Run a saved request (standalone or as a scenario step) and evaluate its assertions. */
  async runRequest(
    id: string,
    environmentId?: string,
    extraVars: Record<string, string> = {},
  ): Promise<RunSavedRequestResult> {
    const req = await this.prisma.savedRequest.findUnique({
      where: { id },
      include: { assertions: true, collection: true },
    });
    if (!req) throw new NotFoundException(`Request ${id} not found`);

    const result = await this.runner.run(
      {
        projectId: req.collection.projectId,
        environmentId,
        endpointId: req.endpointId ?? undefined,
        method: req.method as never,
        url: req.url,
        headers: JSON.parse(req.headersJson),
        body: req.body,
      },
      extraVars,
    );

    const specs: AssertionSpec[] = req.assertions.map((a) => ({
      id: a.id,
      type: a.type as never,
      pathExpr: a.pathExpr ?? undefined,
      operator: a.operator as never,
      expected: a.expected ?? undefined,
    }));

    return { result, assertions: evaluateAssertions(specs, result) };
  }

  private toAssertionRow(a: AssertionSpec) {
    return {
      type: a.type,
      pathExpr: a.pathExpr ?? null,
      operator: a.operator,
      expected: a.expected ?? null,
    };
  }

  private toRequestSummary(r: RequestRow): SavedRequestSummary {
    return {
      id: r.id,
      collectionId: r.collectionId,
      name: r.name,
      endpointId: r.endpointId ?? undefined,
      method: r.method as never,
      url: r.url,
      headers: JSON.parse(r.headersJson),
      body: r.body,
      assertions: r.assertions.map((a) => ({
        id: a.id,
        type: a.type as never,
        pathExpr: a.pathExpr ?? undefined,
        operator: a.operator as never,
        expected: a.expected ?? undefined,
      })),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private async ensure(
    delegate: { findUnique: (args: { where: { id: string } }) => Promise<unknown | null> },
    id: string,
    label: string,
  ) {
    const row = await delegate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`${label} ${id} not found`);
  }
}
