'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BodyField,
  CollectionSummary,
  Endpoint,
  EnvironmentSummary,
  ExecutionSummary,
  RunResult,
} from '@vision/shared';
import { api, emitCollectionsChanged } from '@/lib/api';
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

export function TestPane({
  endpoint,
  projectId,
  envs,
  envId,
}: {
  endpoint: Endpoint;
  projectId: string;
  envs: EnvironmentSummary[];
  envId: string;
}) {
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
  const [saveOpen, setSaveOpen] = useState(false);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [saveTo, setSaveTo] = useState('');
  const [saveName, setSaveName] = useState('');
  const [saved, setSaved] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistory(await api.executions(projectId, endpoint.id).catch(() => []));
  }, [projectId, endpoint.id]);

  useEffect(() => {
    loadHistory();
    // reset per-endpoint state when the selected endpoint changes
    setPathValues({});
    setQueryValues({});
    setBody(exampleBody(endpoint.bodyFields));
    setResult(null);
    setSendError(null);
    setSaveOpen(false);
    setSaved(false);
  }, [endpoint.id, loadHistory, endpoint.bodyFields]);

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
  const activeEnv = envs.find((e) => e.id === envId);

  async function openSave() {
    if (!saveOpen) {
      const payload = await api.collections(projectId).catch(() => ({ collections: [], requests: [] }));
      setCollections(payload.collections);
      setSaveTo(payload.collections[0]?.id ?? '');
      setSaveName(`${endpoint.method} ${endpoint.fullPath}`);
    }
    setSaveOpen(!saveOpen);
    setSaved(false);
  }

  async function saveToCollection() {
    let collectionId = saveTo;
    if (!collectionId) {
      const created = await api.createCollection(projectId, 'default');
      collectionId = created.id;
    }
    await api.createRequest(collectionId, {
      name: saveName || `${endpoint.method} ${endpoint.fullPath}`,
      endpointId: endpoint.id,
      method: endpoint.method,
      url: resolvedPath,
      body: hasBody && body.trim() ? body : undefined,
      assertions: [{ type: 'status', operator: 'lt', expected: '400' }],
    });
    emitCollectionsChanged();
    setSaveOpen(false);
    setSaved(true);
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
      {/* Active environment (managed in the toolbar) */}
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs">
        <span className="text-zinc-500">env:</span>
        {activeEnv ? (
          <span className="font-mono text-zinc-300">
            {activeEnv.name} — {activeEnv.baseUrl}
          </span>
        ) : (
          <span className="text-zinc-500">none — pick one in the toolbar ↗</span>
        )}
      </div>

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

        <div className="flex gap-2">
          <button
            onClick={send}
            disabled={sending || (!envId && !resolvedPath.startsWith('http'))}
            className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
          <button
            onClick={openSave}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition hover:border-zinc-500"
          >
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
        {saveOpen && (
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="request name"
              className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs outline-none focus:border-zinc-600"
            />
            {collections.length > 0 ? (
              <select
                value={saveTo}
                onChange={(e) => setSaveTo(e.target.value)}
                className="rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs outline-none focus:border-zinc-600"
              >
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11px] text-zinc-500">
                No collections — will create one named &quot;default&quot;.
              </p>
            )}
            <button
              onClick={saveToCollection}
              className="rounded bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900"
            >
              Save to collection
            </button>
          </div>
        )}
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
