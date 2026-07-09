import { Injectable, NotFoundException } from '@nestjs/common';
import type { EnvironmentSummary } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertEnvironmentDto } from './environment.dto';

@Injectable()
export class EnvironmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: string): Promise<EnvironmentSummary[]> {
    const rows = await this.prisma.environment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toSummary(r));
  }

  async create(projectId: string, dto: UpsertEnvironmentDto): Promise<EnvironmentSummary> {
    const row = await this.prisma.environment.create({
      data: {
        projectId,
        name: dto.name,
        baseUrl: dto.baseUrl,
        variablesJson: JSON.stringify(dto.variables ?? {}),
        authJson: JSON.stringify(dto.auth ?? { type: 'none' }),
      },
    });
    return this.toSummary(row);
  }

  async update(id: string, dto: UpsertEnvironmentDto): Promise<EnvironmentSummary> {
    const existing = await this.prisma.environment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Environment ${id} not found`);
    const row = await this.prisma.environment.update({
      where: { id },
      data: {
        name: dto.name,
        baseUrl: dto.baseUrl,
        variablesJson: JSON.stringify(dto.variables ?? JSON.parse(existing.variablesJson)),
        authJson: JSON.stringify(dto.auth ?? JSON.parse(existing.authJson)),
      },
    });
    return this.toSummary(row);
  }

  async remove(id: string): Promise<void> {
    await this.prisma.environment.delete({ where: { id } }).catch(() => {
      throw new NotFoundException(`Environment ${id} not found`);
    });
  }

  private toSummary(row: {
    id: string;
    projectId: string;
    name: string;
    baseUrl: string;
    variablesJson: string;
    authJson: string;
    createdAt: Date;
  }): EnvironmentSummary {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      baseUrl: row.baseUrl,
      variables: JSON.parse(row.variablesJson),
      auth: JSON.parse(row.authJson),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
