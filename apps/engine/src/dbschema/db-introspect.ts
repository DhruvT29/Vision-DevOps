import type {
  DbConnectionConfig,
  DbEngine,
  DbForeignKey,
  DbIndex,
  DbTable,
} from '@vision/shared';

/**
 * Pure helpers for DB introspection: resolve a connection from the app's .env
 * (+ per-target overrides), and assemble tables from the driver's rows. The
 * actual query execution (over an SSH tunnel) lives in db-driver.ts.
 */

export interface ResolvedConn {
  engine: DbEngine;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// ── connection resolution ────────────────────────────────────────────────────

function trimOrUndef(s: string | undefined | null): string | undefined {
  const v = (s ?? '').trim();
  return v.length ? v : undefined;
}

/** Minimal dotenv parse: KEY=VALUE, ignores comments/blank, strips quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function pick(env: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = trimOrUndef(env[k]);
    if (v) return v;
  }
  return undefined;
}

function parseDbUrl(url: string): (Partial<ResolvedConn> & { engine?: DbEngine }) | null {
  try {
    const u = new URL(url);
    const proto = u.protocol.replace(/:$/, '').toLowerCase();
    let engine: DbEngine | undefined;
    if (['postgres', 'postgresql', 'pg'].includes(proto)) engine = 'postgres';
    else if (['mysql', 'mariadb'].includes(proto)) engine = 'mysql';
    return {
      engine,
      host: u.hostname || undefined,
      port: u.port ? Number(u.port) : undefined,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: trimOrUndef(decodeURIComponent(u.pathname.replace(/^\//, ''))),
    };
  } catch {
    return null;
  }
}

/**
 * Merge .env-discovered values with per-target overrides (override wins
 * field-by-field). `engineExplicit` is false when the engine had to be guessed
 * (from the port or a postgres default) — the caller then auto-falls-back to
 * the other engine if the connection fails. Throws if the DB name is unknown.
 */
export function resolveConnection(
  env: Record<string, string>,
  override: DbConnectionConfig | null,
): { conn: ResolvedConn; source: 'env' | 'override' | 'mixed'; engineExplicit: boolean } {
  const o = override ?? {};

  // 1. base from a connection URL (an override URL wins over the .env URL)
  let base: Partial<ResolvedConn> & { engine?: DbEngine } = {};
  const overrideUrl = trimOrUndef(o.connectionUrl);
  const envUrl = pick(env, [
    'DATABASE_URL',
    'DB_URL',
    'POSTGRES_URL',
    'PG_URL',
    'MYSQL_URL',
    'PRISMA_DATABASE_URL',
    'TYPEORM_URL',
  ]);
  if (overrideUrl) {
    const p = parseDbUrl(overrideUrl);
    if (!p) throw new Error('the override connection URL could not be parsed');
    base = p;
  } else if (envUrl) {
    base = parseDbUrl(envUrl) ?? {};
  }

  // 2. discrete .env vars fill the gaps
  const engineHint = pick(env, [
    'DB_CONNECTION',
    'DB_DRIVER',
    'DB_ENGINE',
    'DATABASE_ENGINE',
    'DB_DIALECT',
    'TYPEORM_CONNECTION',
  ]);
  const envEngine: DbEngine | undefined = /mysql|maria/i.test(engineHint ?? '')
    ? 'mysql'
    : /pg|postg/i.test(engineHint ?? '')
      ? 'postgres'
      : undefined;

  const envHost = pick(env, [
    'DB_HOST',
    'DATABASE_HOST',
    'PGHOST',
    'MYSQL_HOST',
    'POSTGRES_HOST',
    'TYPEORM_HOST',
  ]);
  const envPort = pick(env, [
    'DB_PORT',
    'DATABASE_PORT',
    'PGPORT',
    'MYSQL_PORT',
    'POSTGRES_PORT',
    'TYPEORM_PORT',
  ]);
  const envDb = pick(env, [
    'DB_NAME',
    'DB_DATABASE',
    'DATABASE_NAME',
    'PGDATABASE',
    'MYSQL_DATABASE',
    'MYSQL_DB',
    'POSTGRES_DB',
    'POSTGRES_DATABASE',
    'TYPEORM_DATABASE',
  ]);
  const envUser = pick(env, [
    'DB_USER',
    'DB_USERNAME',
    'DATABASE_USER',
    'PGUSER',
    'MYSQL_USER',
    'POSTGRES_USER',
    'TYPEORM_USERNAME',
    'TYPEORM_USER',
  ]);
  const envPass = pick(env, [
    'DB_PASS',
    'DB_PASSWORD',
    'DATABASE_PASSWORD',
    'PGPASSWORD',
    'MYSQL_PASSWORD',
    'MYSQL_PWD',
    'POSTGRES_PASSWORD',
    'TYPEORM_PASSWORD',
  ]);

  // 3. engine: explicit (override / URL scheme / text hint) wins; otherwise
  //    infer from the port, else default to postgres.
  const explicitEngine = o.engine ?? base.engine ?? envEngine;
  const portCandidate = o.port ?? base.port ?? (envPort ? Number(envPort) : undefined);
  let engine: DbEngine;
  let engineExplicit: boolean;
  if (explicitEngine) {
    engine = explicitEngine;
    engineExplicit = true;
  } else if (portCandidate === 3306) {
    engine = 'mysql';
    engineExplicit = false;
  } else {
    engine = 'postgres';
    engineExplicit = false;
  }

  const host = trimOrUndef(o.host) ?? base.host ?? envHost ?? '127.0.0.1';
  const port = portCandidate ?? (engine === 'mysql' ? 3306 : 5432);
  const database = trimOrUndef(o.database) ?? base.database ?? envDb;
  const user = trimOrUndef(o.user) ?? base.user ?? envUser ?? (engine === 'mysql' ? 'root' : 'postgres');
  const password = (o.password && o.password.length > 0 ? o.password : undefined) ?? base.password ?? envPass ?? '';

  if (!database) {
    throw new Error(
      'could not determine the database name — set it in the DB connection override or the app .env',
    );
  }

  const anyOverride = !!(
    overrideUrl ||
    o.engine ||
    trimOrUndef(o.host) ||
    o.port ||
    trimOrUndef(o.database) ||
    trimOrUndef(o.user) ||
    (o.password && o.password.length)
  );
  const anyEnv = !!(envUrl || envHost || envDb || envUser || envPass);
  const source = anyOverride && anyEnv ? 'mixed' : anyOverride ? 'override' : 'env';

  return { conn: { engine, host, port, database, user, password }, source, engineExplicit };
}

// ── introspection SQL (run by db-driver over the tunnel, row mode = array) ────

export const PG_QUERIES = {
  columns: `SELECT c.table_schema, c.table_name, c.column_name,
  CASE
    WHEN c.data_type='character varying' THEN 'varchar'||COALESCE('('||c.character_maximum_length||')','')
    WHEN c.data_type='character' THEN 'char'||COALESCE('('||c.character_maximum_length||')','')
    WHEN c.data_type='numeric' THEN 'numeric'||COALESCE('('||c.numeric_precision||','||c.numeric_scale||')','')
    ELSE c.data_type
  END,
  c.is_nullable, c.column_default
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
WHERE c.table_schema NOT IN ('pg_catalog','information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  keys: `SELECT tc.table_schema, tc.table_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position,
  ccu.table_name, ccu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
LEFT JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND tc.constraint_type='FOREIGN KEY'
WHERE tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY') AND tc.table_schema NOT IN ('pg_catalog','information_schema')
ORDER BY tc.table_schema, tc.table_name, tc.constraint_type, kcu.ordinal_position`,
  indexes: `SELECT n.nspname, t.relname, i.relname, ix.indisunique, ix.indisprimary, pg_get_indexdef(ix.indexrelid)
FROM pg_index ix
JOIN pg_class i ON i.oid=ix.indexrelid
JOIN pg_class t ON t.oid=ix.indrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY n.nspname, t.relname, i.relname`,
};

export const MYSQL_QUERIES = {
  columns: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
  keys: `SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME,
  CASE WHEN kcu.REFERENCED_TABLE_NAME IS NULL THEN 'PRIMARY KEY' ELSE 'FOREIGN KEY' END,
  kcu.COLUMN_NAME, kcu.ORDINAL_POSITION, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE kcu
WHERE kcu.TABLE_SCHEMA=DATABASE() AND (kcu.CONSTRAINT_NAME='PRIMARY' OR kcu.REFERENCED_TABLE_NAME IS NOT NULL)
ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
  indexes: `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ','), MAX(NON_UNIQUE)
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME
ORDER BY TABLE_NAME, INDEX_NAME`,
};

// ── table assembly (from array-mode driver rows) ──────────────────────────────

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function pgIndexColumns(indexdef: string): string[] {
  const noWhere = indexdef.replace(/\s+WHERE\s+.*$/i, '');
  const open = noWhere.indexOf('(');
  const close = noWhere.lastIndexOf(')');
  if (open === -1 || close <= open) return [];
  return splitTopLevel(noWhere.slice(open + 1, close))
    .map((c) => c.trim())
    .filter(Boolean);
}

function truthy(v: unknown): boolean {
  return v === true || v === 't' || v === 1 || v === '1';
}

/** Build sorted DbTable[] from the three query result sets (rows as arrays). */
export function assembleTables(
  engine: DbEngine,
  columns: unknown[][],
  keys: unknown[][],
  indexes: unknown[][],
): DbTable[] {
  const tables = new Map<string, DbTable>();
  const getTable = (schema: string, name: string): DbTable => {
    const k = `${schema} ${name}`;
    let t = tables.get(k);
    if (!t) {
      t = { schema, name, columns: [], primaryKey: [], foreignKeys: [], indexes: [] };
      tables.set(k, t);
    }
    return t;
  };

  for (const r of columns) {
    const [schema, name, column, dataType, isNullable, def] = r;
    if (!name || !column) continue;
    getTable(str(schema), str(name)).columns.push({
      name: str(column),
      dataType: str(dataType),
      nullable: str(isNullable).toUpperCase() === 'YES',
      default: def == null ? undefined : str(def),
      isPrimaryKey: false,
    });
  }

  for (const r of keys) {
    const [schema, name, ctype, column, , refTable, refColumn] = r;
    if (!name || !column) continue;
    const t = getTable(str(schema), str(name));
    if (ctype === 'PRIMARY KEY') {
      if (!t.primaryKey.includes(str(column))) t.primaryKey.push(str(column));
    } else if (ctype === 'FOREIGN KEY' && refTable) {
      const fk: DbForeignKey = { column: str(column), refTable: str(refTable), refColumn: str(refColumn) };
      t.foreignKeys.push(fk);
    }
  }

  for (const r of indexes) {
    let idx: DbIndex;
    let schema: string;
    let name: string;
    if (engine === 'postgres') {
      const [sch, tbl, indexName, unique, primary, indexdef] = r;
      schema = str(sch);
      name = str(tbl);
      idx = {
        name: str(indexName),
        columns: pgIndexColumns(str(indexdef)),
        unique: truthy(unique),
        primary: truthy(primary),
      };
    } else {
      const [sch, tbl, indexName, cols, nonUnique] = r;
      schema = str(sch);
      name = str(tbl);
      idx = {
        name: str(indexName),
        columns: str(cols).split(',').filter(Boolean),
        unique: Number(nonUnique) === 0,
        primary: str(indexName) === 'PRIMARY',
      };
    }
    if (name) getTable(schema, name).indexes.push(idx);
  }

  for (const t of tables.values()) {
    const pk = new Set(t.primaryKey);
    for (const c of t.columns) c.isPrimaryKey = pk.has(c.name);
  }

  return [...tables.values()].sort(
    (a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
  );
}
