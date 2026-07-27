import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ServerSummary, ServerTestResult } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { seal, unseal } from './secret-box';
import { testConnection, type SshAuth } from './ssh-runner';
import { CreateServerDto, UpdateServerDto } from './server.dto';

/**
 * Registered SSH servers. The PEM key (+ optional passphrase) is sealed with
 * AES-256-GCM before it touches the DB and is only ever unsealed in memory
 * for a connection — no method here returns key material.
 */
@Injectable()
export class ServersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ServerSummary[]> {
    const rows = await this.prisma.server.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { targets: true } } },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      createdAt: s.createdAt.toISOString(),
      targetCount: s._count.targets,
    }));
  }

  async create(dto: CreateServerDto): Promise<ServerSummary> {
    const row = await this.prisma.server.create({
      data: {
        name: dto.name,
        host: dto.host,
        port: dto.port ?? 22,
        username: dto.username,
        encryptedAuthJson: seal(
          JSON.stringify({ privateKey: dto.privateKey, passphrase: dto.passphrase }),
        ),
      },
    });
    return this.summary(row.id);
  }

  async update(id: string, dto: UpdateServerDto): Promise<ServerSummary> {
    const existing = await this.prisma.server.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No server ${id}`);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.host !== undefined) data.host = dto.host;
    if (dto.port !== undefined) data.port = dto.port;
    if (dto.username !== undefined) data.username = dto.username;
    if (dto.privateKey && dto.privateKey.trim().length > 0) {
      data.encryptedAuthJson = seal(
        JSON.stringify({ privateKey: dto.privateKey, passphrase: dto.passphrase }),
      );
    }
    await this.prisma.server.update({ where: { id }, data });
    return this.summary(id);
  }

  async remove(id: string): Promise<{ ok: true }> {
    const existing = await this.prisma.server.findUnique({
      where: { id },
      include: { _count: { select: { targets: true } } },
    });
    if (!existing) throw new NotFoundException(`No server ${id}`);
    if (existing._count.targets > 0) {
      throw new ConflictException(
        `Server is in use by ${existing._count.targets} deploy target(s)`,
      );
    }
    await this.prisma.server.delete({ where: { id } });
    return { ok: true };
  }

  async test(id: string): Promise<ServerTestResult> {
    return testConnection(await this.auth(id));
  }

  /** Decrypted connection auth for the runner — in-memory use only. */
  async auth(id: string): Promise<SshAuth> {
    const row = await this.prisma.server.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`No server ${id}`);
    const secret = JSON.parse(unseal(row.encryptedAuthJson)) as {
      privateKey: string;
      passphrase?: string;
    };
    return {
      host: row.host,
      port: row.port,
      username: row.username,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
    };
  }

  private async summary(id: string): Promise<ServerSummary> {
    const s = await this.prisma.server.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { targets: true } } },
    });
    return {
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      createdAt: s.createdAt.toISOString(),
      targetCount: s._count.targets,
    };
  }
}
