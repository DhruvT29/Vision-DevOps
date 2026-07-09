'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BodyField,
  Endpoint,
  EnvironmentSummary,
  ExecutionSummary,
  RunResult,
} from '@vision/shared';
import { api } from '@/lib/api';
import { methodBadge } from '@/lib/method-colors';

function exampleValue(f: BodyField): unknown {
  const t = f.type.toLowerCase();
  if (t.includes('string')) return '';
  if (t.includes('number')) return 0;
  if (t.includes('boolean')) return false;
  if (t.includes('[]') || t.includes('array')) return [];
  return '';
}

function exampleBody(fields: BodyField[] | null): string {
  if (!fields || fields.length === 0) return '';
  const obj: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.optional) obj[f.name] = exampleValue(f);
  }
  // include optional fields commented out is impossible in JSON — include all
  // optionals too so the user can see & delete them:
  for (const f of fields) {
    if (f.optional && !(f.name in obj)) obj[f.name] = exampleValue(f);
  }
  return JSON.stringify(obj, null, 2);
}

export function TestPane({ endpoint, projectId }: { endpoint: Endpoint; projectId: string }) {
  const [envs, setEnvs] = useState<EnvironmentSummary[]>([]);
  const [envId, setEnvId] = useState<string>('');
  const [showNewEnv, setShowNewEnv] = useState(false);
  const [newEnv, setNewEnv] = useState({ name: '', baseUrl: '', token: '' });

  const pathParams = useMemo(
    () => endpoint.params.filter((p) => p.source === 'path'),
    [endpoint],
  );
  const queryParams = useMemo(
    () => endpoint.params.filter((p) => p.source === 'query'),
    [endpoint],
  );
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState(() => exampleBody(endpoint.bodyFields));
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [history, setHistory] = useState<ExecutionSummary[]>([]);

  const loadEnvs = useCallback(async () => {
    const list = await api.listEnvironments(projectId);
    setEnvs(list);
    if (list.length > 0) setEnvId((prev) => prev || list[0].id);
  }, [projectId]);

  const loadHistory = useCallback(async () => {
    setHistory(await api.executions(projectId, endpoint.id).catch(() => []));
  }, [projectId, endpoint.id]);

  useEffect(() => {
    loadEnvs().catch(() => {});
    loadHistory();
    // reset per-endpoint state when the selected endpoint changes
    setPathValues({});
    setQueryValues({});
    setBody(exampleBody(endpoint.bodyFields));
    setResult(null);
    setSendError(null);
  }, [endpoint.id, loadEnvs, loadHistory, endpoint.bodyFields]);

  const resolvedPath = useMemo(() => {
    let p = endpoint.fullPath;
    for (const param of pathParams) {
      const v = pathValues[param.name];
      if (v) p = p.replace(`:${param.name}`, encodeURIComponent(v));
    }
    const qs = Object.entries(queryValues)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return qs ? `${p}?${qs}` : p;
  }, [endpoint.fullPath, pathParams, pathValues, queryValues]);

  const hasBody = endpoint.method !== 'GET' && endpoint.method !== 'HEAD';

  async function createEnv() {
    if (!newEnv.name || !newEnv.baseUrl) return;
    const created = await api.createEnvironment(projectId, {
      name: newEnv.name,
      baseUrl: newEnv.baseUrl,
      auth: newEnv.token ? { type: 'bearer', token: newEnv.token } : { type: 'none' },
    });
    setShowNewEnv(false);
    setNewEnv({ name: '', baseUrl: '', token: '' });
    await loadEnvs();
    setEnvId(created.id);
  }

  async function send() {
    setSending(true);
    setSendError(null);
    setResult(null);
    try {
      const res = await api.run({
        projectId,
        environmentId: envId || undefined,
        endpointId: endpoint.id,
        method: endpoint.method,
        url: resolvedPath,
        body: hasBody && body.trim() ? body : undefined,
      });
      setResult(res);
      loadHistory();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const prettyBody = useMemo(() => {
    if (!result?.body) return '';
    try {
      return JSON.stringify(JSON.parse(result.body), null, 2);
    } catch {
      return result.body;
    }
  }, [result]);

  return (
    <div className="flex flex-col gap-5">
      {/* Environment */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Environment
          </h3>
          <button
            onClick={() => setShowNewEnv((s) => !s)}
            className="text-xs text-sky-400 hover:underline"
          >
            {showNewEnv ? 'cancel' : '+ new'}
          </button>
        </div>
        {envs.length > 0 && !showNewEnv && (
          <select
            value={envId}
            onChange={(e) => setEnvId(e.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600"
          >
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.baseUrl}
              </option>
            ))}
          </select>
        )}
        {envs.length === 0 && !showNewEnv && (
          <p className="text-xs text-zinc-500">
            No environments yet — create one to point at your running app.
          </p>
        )}
        {showNewEnv && (
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <input
              placeholder="name (e.g. local)"
              value={newEnv.name}
              onChange={(e) => setNewEnv({ ...newEnv, name: e.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-zinc-600"
            />
            <input
              placeholder="base URL (e.g. http://localhost:8001)"
              value={newEnv.baseUrl}
              onChange={(e) => setNewEnv({ ...newEnv, baseUrl: e.target.value })}
              spellCheck={false}
              className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-zinc-600"
            />
            <input
              placeholder="bearer token (optional)"
              value={newEnv.token}
              onChange={(e) => setNewEnv({ ...newEnv, token: e.target.value })}
              spellCheck={false}
              className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-zinc-600"
            />
            <button
              onClick={createEnv}
              disabled={!newEnv.name || !newEnv.baseUrl}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-semibold text-zinc-900 disabled:opacity-40"
            >
              Create
            </button>
          </div>
        )}
      </section>

      {/* Request */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Request</h3>
        <code className="break-all rounded bg-zinc-900 px-2.5 py-2 font-mono text-xs text-zinc-300">
          {resolvedPath}
        </code>

        {pathParams.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {pathParams.map((p) => (
              <div key={p.name} className="flex items-center gap-2">
                <span className="w-28 shrink-0 font-mono text-xs text-sky-400">:{p.name}</span>
                <input
                  value={pathValues[p.name] ?? ''}
                  onChange={(e) => setPathValues({ ...pathValues, [p.name]: e.target.value })}
                  spellCheck={false}
                  className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs outline-none focus:border-zinc-600"
                />
              </div>
            ))}
          </div>
        )}

        {queryParams.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {queryParams.map((p) => (
              <div key={p.name} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate font-mono text-xs text-violet-400">
                  ?{p.name}
                </span>
                <input
                  value={queryValues[p.name] ?? ''}
                  onChange={(e) => setQueryValues({ ...queryValues, [p.name]: e.target.value })}
                  placeholder={p.optional ? 'optional' : ''}
                  spellCheck={false}
                  className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs outline-none placeholder:text-zinc-700 focus:border-zinc-600"
                />
              </div>
            ))}
          </div>
        )}

        {hasBody && (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(14, Math.max(4, body.split('\n').length + 1))}
            spellCheck={false}
            placeholder="request body (JSON)"
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed outline-none placeholder:text-zinc-700 focus:border-zinc-600"
          />
        )}

        <button
          onClick={send}
          disabled={sending || (!envId && !resolvedPath.startsWith('http'))}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        {!envId && (
          <p className="text-[11px] text-zinc-500">Select or create an environment to send.</p>
        )}
        {sendError && <p className="text-xs text-red-400">{sendError}</p>}
      </section>

      {/* Response */}
      {result && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Response
          </h3>
          <div className="flex items-center gap-3 text-sm">
            {result.error ? (
              <span className="font-semibold text-red-400">{result.error}</span>
            ) : (
              <>
                <span
                  className={`font-mono font-bold ${
                    (result.status ?? 0) < 300
                      ? 'text-emerald-400'
                      : (result.status ?? 0) < 400
                        ? 'text-amber-400'
                        : 'text-red-400'
                  }`}
                >
                  {result.status} {result.statusText}
                </span>
                <span className="text-xs text-zinc-500">{result.durationMs} ms</span>
                {result.truncated && (
                  <span className="text-[10px] text-amber-500">truncated</span>
                )}
              </>
            )}
          </div>
          {prettyBody && (
            <pre className="max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
              {prettyBody}
            </pre>
          )}
        </section>
      )}

      {/* History */}
      {history.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            History
          </h3>
          {history.slice(0, 10).map((h) => (
            <div
              key={h.id}
              className="flex items-center gap-2 rounded border border-zinc-900 bg-zinc-900/40 px-2.5 py-1.5 text-xs"
            >
              <span className={`rounded border px-1 py-0 font-mono text-[9px] font-bold ${methodBadge(h.method)}`}>
                {h.method}
              </span>
              <span
                className={`font-mono font-semibold ${
                  h.error
                    ? 'text-red-400'
                    : (h.status ?? 0) < 300
                      ? 'text-emerald-400'
                      : 'text-red-400'
                }`}
              >
                {h.error ? 'ERR' : h.status}
              </span>
              <span className="text-zinc-500">{h.durationMs}ms</span>
              <span className="ml-auto text-[10px] text-zinc-600">
                {new Date(h.createdAt).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
