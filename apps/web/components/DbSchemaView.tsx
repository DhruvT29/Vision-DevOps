'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  DbConnectionInfo,
  DbEngine,
  DbSchemaResult,
  DbTable,
  DeployTargetSummary,
  SnapshotSummary,
} from '@vision/shared';
import { api } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/BranchSwitcher';

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const ENGINE_LABEL: Record<DbEngine, string> = { postgres: 'PostgreSQL', mysql: 'MySQL' };

export function DbSchemaView({ snapshotId }: { snapshotId: string }) {
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [targets, setTargets] = useState<DeployTargetSummary[] | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [result, setResult] = useState<DbSchemaResult | null>(null);
  const [connInfo, setConnInfo] = useState<DbConnectionInfo | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showConn, setShowConn] = useState(false);

  // resolve project + targets
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.snapshot(snapshotId);
        if (cancelled) return;
        setSnapshot(snap);
        setProjectId(snap.projectId);
        const t = await api.deployTargets(snap.projectId);
        if (cancelled) return;
        setTargets(t);
        setTargetId((cur) => cur ?? t[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshotId]);

  // load cached schema + connection info when the target changes
  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    setResult(null);
    setFetchError(null);
    setFilter('');
    setShowConn(false);
    (async () => {
      const [cached, conn] = await Promise.all([
        api.dbSchema(targetId).catch(() => null),
        api.dbConnection(targetId).catch(() => null),
      ]);
      if (cancelled) return;
      setResult(cached);
      setConnInfo(conn);
    })();
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  const fetchSchema = useCallback(async () => {
    if (!targetId) return;
    setFetching(true);
    setFetchError(null);
    try {
      const r = await api.fetchDbSchema(targetId);
      setResult(r);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [targetId]);

  const tables = useMemo(() => {
    if (!result) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return result.tables;
    return result.tables.filter(
      (t) => t.name.toLowerCase().includes(q) || `${t.schema}.${t.name}`.toLowerCase().includes(q),
    );
  }, [result, filter]);

  if (loadError) {
    return (
      <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-rose-400">Could not load the schema section</p>
          <p className="max-w-lg text-center font-mono text-xs text-zinc-500">{loadError}</p>
          <Link href="/" className="text-sm text-sky-400 hover:underline">
            ← back
          </Link>
        </div>
      </AppShell>
    );
  }

  if (!targets) {
    return (
      <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200" />
          <p className="text-sm text-zinc-400">Loading…</p>
        </div>
      </AppShell>
    );
  }

  if (targets.length === 0) {
    return (
      <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <DatabaseGlyph />
          <p className="text-sm text-zinc-300">No deploy targets yet</p>
          <p className="max-w-md text-xs text-zinc-500">
            This section pulls the live schema from a server you registered in Deployment. Create a
            deploy target first — its server + working directory are used to reach the database.
          </p>
          <Link
            href={`/deploy/${snapshotId}`}
            className="mt-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-500"
          >
            Go to Deployment →
          </Link>
        </div>
      </AppShell>
    );
  }

  const selected = targets.find((t) => t.id === targetId) ?? null;

  return (
    <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* controls */}
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-6 py-3">
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            Target
            <select
              value={targetId ?? ''}
              onChange={(e) => setTargetId(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.host}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => void fetchSchema()}
            disabled={fetching}
            className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-60"
          >
            {fetching ? <Spinner className="h-4 w-4 text-emerald-300" /> : <RefreshIcon />}
            {result ? 'Re-fetch schema' : 'Fetch schema'}
          </button>

          {result && (
            <span className="text-xs text-zinc-500">
              <span className="text-zinc-300">{ENGINE_LABEL[result.engine]}</span> ·{' '}
              <span className="font-mono text-zinc-300">{result.database}</span> ·{' '}
              {result.tables.length} tables · fetched {timeAgo(result.fetchedAt)}
            </span>
          )}

          <button
            type="button"
            onClick={() => setShowConn((s) => !s)}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
          >
            <GearIcon />
            DB connection
            {connInfo?.configured && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
          </button>

          {result && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tables…"
              spellCheck={false}
              className="w-44 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
            />
          )}
        </div>

        {showConn && selected && (
          <ConnectionEditor
            key={selected.id}
            target={selected}
            info={connInfo}
            onSaved={(info) => setConnInfo(info)}
          />
        )}

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {fetchError && (
            <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
              {fetchError}
            </div>
          )}
          {result?.warnings?.map((w) => (
            <div
              key={w}
              className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300"
            >
              {w}
            </div>
          ))}

          {!result ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <DatabaseGlyph />
              <p className="text-sm text-zinc-400">No schema fetched yet</p>
              <p className="max-w-md text-xs text-zinc-500">
                Click <span className="text-emerald-300">Fetch schema</span> to connect to{' '}
                <span className="font-mono text-zinc-300">{selected?.host}</span> over SSH and read
                the live database structure.
              </p>
            </div>
          ) : tables.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {result.tables.length === 0
                ? 'The database has no tables.'
                : 'No tables match the filter.'}
            </p>
          ) : (
            <div className="gap-4 sm:columns-2 xl:columns-3">
              {tables.map((t) => (
                <TableCard key={`${t.schema}.${t.name}`} table={t} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── one table ─────────────────────────────────────────────────────────────────

function TableCard({ table }: { table: DbTable }) {
  const fkCols = useMemo(() => new Set(table.foreignKeys.map((f) => f.column)), [table.foreignKeys]);
  return (
    <div className="mb-4 flex break-inside-avoid flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-baseline justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
        <div className="min-w-0 truncate">
          {table.schema !== 'public' && (
            <span className="text-xs text-zinc-500">{table.schema}.</span>
          )}
          <span className="font-mono text-sm font-semibold text-zinc-100">{table.name}</span>
        </div>
        <span className="shrink-0 text-[10px] text-zinc-500">{table.columns.length} cols</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {table.columns.map((c) => (
              <tr key={c.name} className="border-b border-zinc-800/60 last:border-0">
                <td className="whitespace-nowrap py-1.5 pl-3 pr-2 align-top font-mono text-zinc-200">
                  {c.name}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-2 align-top font-mono text-[11px] text-sky-300/80">
                  {c.dataType}
                </td>
                <td className="py-1.5 pr-3 align-top">
                  <span className="flex flex-wrap items-center justify-end gap-1">
                    {c.isPrimaryKey && (
                      <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-300">
                        PK
                      </span>
                    )}
                    {fkCols.has(c.name) && (
                      <span className="rounded bg-sky-500/15 px-1 py-0.5 text-[9px] font-medium text-sky-300">
                        FK
                      </span>
                    )}
                    {!c.nullable && !c.isPrimaryKey && (
                      <span className="text-[9px] text-zinc-600">NOT NULL</span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {table.foreignKeys.length > 0 && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">Foreign keys</p>
          <ul className="space-y-0.5">
            {table.foreignKeys.map((f, i) => (
              <li key={`${f.column}-${i}`} className="font-mono text-[11px] text-zinc-400">
                <span className="text-sky-300">{f.column}</span> →{' '}
                {f.refTable}.{f.refColumn}
              </li>
            ))}
          </ul>
        </div>
      )}

      {table.indexes.length > 0 && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">Indexes</p>
          <ul className="space-y-0.5">
            {table.indexes.map((idx) => (
              <li key={idx.name} className="flex items-baseline gap-1.5 text-[11px]">
                <span className="font-mono text-zinc-400">{idx.name}</span>
                <span className="font-mono text-zinc-600">({idx.columns.join(', ')})</span>
                {idx.primary ? (
                  <span className="text-[9px] text-amber-400">PRIMARY</span>
                ) : idx.unique ? (
                  <span className="text-[9px] text-emerald-400">UNIQUE</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── connection override editor ────────────────────────────────────────────────

function ConnectionEditor({
  target,
  info,
  onSaved,
}: {
  target: DeployTargetSummary;
  info: DbConnectionInfo | null;
  onSaved: (info: DbConnectionInfo) => void;
}) {
  const [engine, setEngine] = useState<'' | DbEngine>(info?.engine ?? '');
  const [host, setHost] = useState(info?.host ?? '');
  const [port, setPort] = useState(info?.port ? String(info.port) : '');
  const [database, setDatabase] = useState(info?.database ?? '');
  const [user, setUser] = useState(info?.user ?? '');
  const [password, setPassword] = useState('');
  const [envPath, setEnvPath] = useState(info?.envPath ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(clear = false) {
    setSaving(true);
    setError(null);
    try {
      const body = clear
        ? {}
        : {
            engine: engine || undefined,
            host: host.trim() || undefined,
            port: port.trim() ? Number(port) : undefined,
            database: database.trim() || undefined,
            user: user.trim() || undefined,
            password: password || undefined,
            envPath: envPath.trim() || undefined,
          };
      const saved = await api.saveDbConnection(target.id, body);
      onSaved(saved);
      setPassword('');
      if (clear) {
        setEngine('');
        setHost('');
        setPort('');
        setDatabase('');
        setUser('');
        setEnvPath('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const field = 'rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500';

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/40 px-6 py-4">
      <p className="mb-1 text-xs text-zinc-400">
        Connection override for <span className="text-zinc-200">{target.name}</span>
      </p>
      <p className="mb-3 max-w-3xl text-[11px] text-zinc-600">
        Leave everything blank to auto-detect from the app’s{' '}
        <span className="font-mono">.env</span> in{' '}
        <span className="font-mono text-zinc-500">{target.workingDir}</span>. Any field you set here
        wins over the <span className="font-mono">.env</span>. The password is stored sealed and is
        never shown again.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
          Engine
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as '' | DbEngine)}
            className={field}
          >
            <option value="">auto</option>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
          Host
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="from .env" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
          Port
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="from .env" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
          Database
          <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="from .env" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
          User
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="from .env" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-600">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={info?.hasPassword ? '•••• saved' : 'from .env'}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-600 sm:col-span-2">
          .env path (optional)
          <input
            value={envPath}
            onChange={(e) => setEnvPath(e.target.value)}
            placeholder="defaults to <workingDir>/.env"
            className={field}
          />
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save(false)}
          disabled={saving}
          className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs text-zinc-100 transition hover:border-zinc-400 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save override'}
        </button>
        {info?.configured && (
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={saving}
            className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 transition hover:text-rose-400 disabled:opacity-60"
          >
            Clear override
          </button>
        )}
      </div>
    </div>
  );
}

// ── icons ─────────────────────────────────────────────────────────────────────

function DatabaseGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-10 w-10 text-zinc-700">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
