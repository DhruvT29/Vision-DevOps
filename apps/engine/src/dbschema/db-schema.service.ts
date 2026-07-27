import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  DbConnectionConfig,
  DbConnectionInfo,
  DbEngine,
  DbSchemaResult,
  DbTable,
} from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ServersService } from '../deploy/servers.service';
import { seal, unseal } from '../deploy/secret-box';
import { execCollect, shq } from '../deploy/ssh-runner';
import { DbConnectionConfigDto } from './db-config.dto';
import { parseEnv, resolveConnection, type ResolvedConn } from './db-introspect';
import { introspectViaTunnel } from './db-driver';

function trim(s: string | undefined | null): string | undefined {
  const v = (s ?? '').trim();
  return v.length ? v : undefined;
}

/**
 * Live database introspection for a deploy target. Reuses the deploy PEM path:
 * SSH in with the server's sealed key, read the app's .env (+ any sealed
 * override), run psql/mysql on the box, and parse the schema. Passwords are
 * sealed at rest, unsealed only in memory, passed to the remote CLI via an env
 * var (never argv), and never returned or logged.
 */
@Injectable()
export class DbSchemaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly servers: ServersService,
  ) {}

  async getConnectionInfo(targetId: string): Promise<DbConnectionInfo> {
    const target = await this.prisma.deployTarget.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException(`No deploy target ${targetId}`);
    if (!target.dbConfigJson) return { configured: false, hasPassword: false };
    const cfg = JSON.parse(unseal(target.dbConfigJson)) as DbConnectionConfig;
    return {
      configured: true,
      engine: cfg.engine,
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      hasPassword: !!(cfg.password && cfg.password.length),
      envPath: cfg.envPath,
    };
  }

  async saveConnection(targetId: string, dto: DbConnectionConfigDto): Promise<DbConnectionInfo> {
    const target = await this.prisma.deployTarget.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException(`No deploy target ${targetId}`);

    const provided =
      !!dto.engine ||
      !!trim(dto.connectionUrl) ||
      !!trim(dto.host) ||
      !!dto.port ||
      !!trim(dto.database) ||
      !!trim(dto.user) ||
      !!(dto.password && dto.password.length) ||
      !!trim(dto.envPath);

    if (!provided) {
      await this.prisma.deployTarget.update({ where: { id: targetId }, data: { dbConfigJson: null } });
      return { configured: false, hasPassword: false };
    }

    // omitted/blank password keeps the existing sealed one (like the server PEM)
    const existing = target.dbConfigJson
      ? (JSON.parse(unseal(target.dbConfigJson)) as DbConnectionConfig)
      : null;
    const cfg: DbConnectionConfig = {
      engine: dto.engine,
      connectionUrl: trim(dto.connectionUrl),
      host: trim(dto.host),
      port: dto.port,
      database: trim(dto.database),
      user: trim(dto.user),
      password: dto.password && dto.password.length ? dto.password : existing?.password,
      envPath: trim(dto.envPath),
    };
    await this.prisma.deployTarget.update({
      where: { id: targetId },
      data: { dbConfigJson: seal(JSON.stringify(cfg)) },
    });
    return this.getConnectionInfo(targetId);
  }

  async getCached(targetId: string): Promise<DbSchemaResult | null> {
    const row = await this.prisma.dbSchemaCache.findUnique({ where: { targetId } });
    if (!row) return null;
    return JSON.parse(row.schemaJson) as DbSchemaResult;
  }

  async fetchSchema(targetId: string): Promise<DbSchemaResult> {
    const target = await this.prisma.deployTarget.findUnique({
      where: { id: targetId },
      include: { server: true },
    });
    if (!target) throw new NotFoundException(`No deploy target ${targetId}`);

    const override = target.dbConfigJson
      ? (JSON.parse(unseal(target.dbConfigJson)) as DbConnectionConfig)
      : null;
    const auth = await this.servers.auth(target.serverId);
    const warnings: string[] = [];
    const envLabel = override?.envPath?.trim() || `${target.workingDir}/.env`;

    // 1. read the app's .env (best-effort — the override may fully specify things)
    let env: Record<string, string> = {};
    let envRead = false;
    let catCode = -1;
    try {
      const cat = await execCollect(auth, this.envReadCommand(target.workingDir, override?.envPath));
      catCode = cat.code;
      if (cat.code === 0) {
        env = parseEnv(cat.stdout);
        envRead = true;
      } else {
        warnings.push(`could not read ${envLabel} (cat exited ${cat.code}); using the override only`);
      }
    } catch {
      warnings.push(`could not read ${envLabel}; using the override only`);
    }

    // 2. resolve the connection (env + override). A failure here is a config
    //    problem, not a server error — surface it as a 400 with a diagnostic.
    let conn: ResolvedConn;
    let source: DbSchemaResult['source'];
    let engineExplicit = false;
    try {
      ({ conn, source, engineExplicit } = resolveConnection(env, override));
    } catch (e) {
      const dbKeys = Object.keys(env).filter((k) => /(DB|DATABASE|PG|MYSQL|POSTGRES|TYPEORM)/i.test(k));
      const diag = envRead
        ? `read ${envLabel} (${Object.keys(env).length} vars${
            dbKeys.length ? `; DB-related keys: ${dbKeys.join(', ')}` : '; none looked DB-related'
          })`
        : `could not read ${envLabel} (cat exited ${catCode})`;
      throw new BadRequestException(`${this.msg(e)} — ${diag}. Open “DB connection” to set it manually.`);
    }

    // 3. introspect over an SSH tunnel with a DB driver — nothing is installed
    //    or run on the box beyond the read above; every query is a SELECT.
    let tables: DbTable[];
    let engineUsed: DbEngine = conn.engine;
    try {
      tables = await introspectViaTunnel(auth, conn);
    } catch (e) {
      if (engineExplicit) throw this.introspectError(e, conn);
      // engine was a guess and the connection failed → try the other one
      const other: DbEngine = conn.engine === 'postgres' ? 'mysql' : 'postgres';
      const defaulted = conn.port === (conn.engine === 'postgres' ? 5432 : 3306);
      const alt: ResolvedConn = {
        ...conn,
        engine: other,
        port: defaulted ? (other === 'postgres' ? 5432 : 3306) : conn.port,
      };
      try {
        tables = await introspectViaTunnel(auth, alt);
        conn = alt;
        engineUsed = other;
      } catch (e2) {
        throw this.introspectError(e2, alt);
      }
    }

    const result: DbSchemaResult = {
      engine: engineUsed,
      database: conn.database,
      source,
      fetchedAt: new Date().toISOString(),
      tables,
      warnings: warnings.length ? warnings : undefined,
    };

    await this.prisma.dbSchemaCache.upsert({
      where: { targetId },
      create: {
        targetId,
        engine: result.engine,
        database: result.database,
        schemaJson: JSON.stringify(result),
      },
      update: {
        engine: result.engine,
        database: result.database,
        schemaJson: JSON.stringify(result),
        fetchedAt: new Date(),
      },
    });

    return result;
  }

  /** Map a driver/tunnel failure to a clean, redacted 400 with guidance. */
  private introspectError(e: unknown, conn: ResolvedConn): BadRequestException {
    const raw = this.redact(this.msg(e), conn.password);
    const at = `${conn.host}:${conn.port}/${conn.database}`;
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timeout/i.test(raw)) {
      return new BadRequestException(
        `could not reach the database at ${at} from the server — check the host/port, or set them in “DB connection” (${raw})`,
      );
    }
    if (/password authentication failed|access denied|authentication/i.test(raw)) {
      return new BadRequestException(
        `database authentication failed for user “${conn.user}” at ${at} — check the credentials in “DB connection”`,
      );
    }
    if (/does not exist|unknown database/i.test(raw)) {
      return new BadRequestException(
        `database “${conn.database}” not found at ${conn.host}:${conn.port} — check the name in “DB connection”`,
      );
    }
    return new BadRequestException(`database introspection failed (${conn.engine} at ${at}): ${raw.slice(0, 600)}`);
  }

  /** `cat` the .env: an absolute override path directly, else relative to the working dir. */
  private envReadCommand(workingDir: string, envPath?: string): string {
    const p = (envPath ?? '').trim();
    if (p.startsWith('/')) return `bash -lc ${shq(`cat ${shq(p)}`)}`;
    const rel = p || '.env';
    return `bash -lc ${shq(`cd ${shq(workingDir)} && cat ${shq(rel)}`)}`;
  }

  private redact(text: string, secret: string): string {
    return secret ? text.split(secret).join('***') : text;
  }

  private msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
