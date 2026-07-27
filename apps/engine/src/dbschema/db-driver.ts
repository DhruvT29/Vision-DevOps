import net from 'node:net';
import { Client as SshClient } from 'ssh2';
import { Client as PgClient } from 'pg';
import { createConnection, type Connection as MysqlConnection } from 'mysql2/promise';
import type { DbTable } from '@vision/shared';
import type { SshAuth } from '../deploy/ssh-runner';
import { assembleTables, MYSQL_QUERIES, PG_QUERIES, type ResolvedConn } from './db-introspect';

/**
 * Introspect a database over an SSH tunnel — no DB client needed on the box.
 * A local TCP server bridges each connection to a fresh `forwardOut` channel,
 * so pg/mysql2 connect to a normal local port (127.0.0.1:<ephemeral>). Every
 * query is a read against information_schema/pg_catalog; nothing is written.
 */

const CONNECT_TIMEOUT = 15_000;
const QUERY_TIMEOUT = 25_000;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sshConnect(auth: SshAuth): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const c = new SshClient();
    c.once('ready', () => resolve(c))
      .once('error', reject)
      .connect({
        host: auth.host,
        port: auth.port,
        username: auth.username,
        privateKey: auth.privateKey,
        passphrase: auth.passphrase,
        readyTimeout: CONNECT_TIMEOUT,
        tryKeyboard: false,
      });
  });
}

export async function introspectViaTunnel(auth: SshAuth, conn: ResolvedConn): Promise<DbTable[]> {
  const ssh = await sshConnect(auth);
  const server = net.createServer((sock) => {
    ssh.forwardOut('127.0.0.1', 0, conn.host, conn.port, (err, ch) => {
      if (err) {
        sock.destroy();
        return;
      }
      sock.pipe(ch).pipe(sock);
      const kill = () => {
        try {
          ch.end();
        } catch {
          /* noop */
        }
        try {
          sock.destroy();
        } catch {
          /* noop */
        }
      };
      sock.on('error', kill);
      ch.on('error', kill);
    });
  });
  try {
    await new Promise<void>((res, rej) => {
      server.once('error', rej);
      server.listen(0, '127.0.0.1', () => res());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return conn.engine === 'postgres'
      ? await introspectPg(conn, port)
      : await introspectMysql(conn, port);
  } finally {
    server.close();
    ssh.end();
  }
}

async function introspectPg(conn: ResolvedConn, port: number): Promise<DbTable[]> {
  const open = async (ssl: false | { rejectUnauthorized: false }): Promise<PgClient> => {
    const client = new PgClient({
      host: '127.0.0.1',
      port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl,
      connectionTimeoutMillis: CONNECT_TIMEOUT,
      statement_timeout: QUERY_TIMEOUT,
    });
    await client.connect();
    return client;
  };

  let client: PgClient;
  try {
    client = await open(false);
  } catch (e) {
    // server requires TLS → retry once with TLS (already inside an SSH tunnel)
    if (/no encryption|ssl|sslmode/i.test(msg(e))) client = await open({ rejectUnauthorized: false });
    else throw e;
  }
  try {
    const q = async (sql: string): Promise<unknown[][]> =>
      (await client.query({ text: sql, rowMode: 'array' })).rows as unknown[][];
    const columns = await q(PG_QUERIES.columns);
    const keys = await q(PG_QUERIES.keys);
    const indexes = await q(PG_QUERIES.indexes);
    return assembleTables('postgres', columns, keys, indexes);
  } finally {
    await client.end().catch(() => {});
  }
}

async function introspectMysql(conn: ResolvedConn, port: number): Promise<DbTable[]> {
  const open = (ssl: undefined | { rejectUnauthorized: false }) =>
    createConnection({
      host: '127.0.0.1',
      port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl,
      connectTimeout: CONNECT_TIMEOUT,
      rowsAsArray: true,
    });

  let c: MysqlConnection;
  try {
    c = await open(undefined);
  } catch (e) {
    if (/secure transport|ssl/i.test(msg(e))) c = await open({ rejectUnauthorized: false });
    else throw e;
  }
  try {
    const q = async (sql: string): Promise<unknown[][]> => {
      const [rows] = await c.query(sql);
      return rows as unknown[][];
    };
    const columns = await q(MYSQL_QUERIES.columns);
    const keys = await q(MYSQL_QUERIES.keys);
    const indexes = await q(MYSQL_QUERIES.indexes);
    return assembleTables('mysql', columns, keys, indexes);
  } finally {
    await c.end().catch(() => {});
  }
}
