'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  AssertionSpec,
  CollectionsPayload,
  RunSavedRequestResult,
  SavedRequestSummary,
} from '@vision/shared';
import { api, onCollectionsChanged } from '@/lib/api';
import { methodBadge } from '@/lib/method-colors';

const ASSERTION_TYPES = ['status', 'jsonPath', 'header', 'responseTime'] as const;
const OPERATORS = ['eq', 'neq', 'lt', 'gt', 'contains', 'exists'] as const;

export function CollectionsPane({ projectId, envId }: { projectId: string; envId: string }) {
  const [data, setData] = useState<CollectionsPayload>({ collections: [], requests: [] });
  const [newName, setNewName] = useState('');
  const [expandedReq, setExpandedReq] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunSavedRequestResult>>({});
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api.collections(projectId).catch(() => ({ collections: [], requests: [] })));
  }, [projectId]);

  useEffect(() => {
    load();
    return onCollectionsChanged(load);
  }, [load]);

  async function createCollection() {
    if (!newName.trim()) return;
    await api.createCollection(projectId, newName.trim());
    setNewName('');
    load();
  }

  async function run(req: SavedRequestSummary) {
    setRunning(req.id);
    try {
      const res = await api.runSavedRequest(req.id, envId || undefined);
      setResults((prev) => ({ ...prev, [req.id]: res }));
    } catch (e) {
      // engine-level failure (e.g. no env for relative URL)
      setResults((prev) => ({
        ...prev,
        [req.id]: {
          result: {
            executionId: '',
            url: req.url,
            durationMs: 0,
            responseHeaders: {},
            body: '',
            truncated: false,
            error: e instanceof Error ? e.message : String(e),
          },
          assertions: [],
        },
      }));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createCollection()}
          placeholder="new collection…"
          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
        <button
          onClick={createCollection}
          disabled={!newName.trim()}
          className="rounded border border-zinc-700 px-2.5 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
        >
          +
        </button>
      </div>

      {data.collections.length === 0 && (
        <p className="text-xs text-zinc-600">
          No collections yet. Create one, then save requests from an endpoint&apos;s Test tab.
        </p>
      )}

      {data.collections.map((col) => {
        const requests = data.requests.filter((r) => r.collectionId === col.id);
        return (
          <div key={col.id} className="flex flex-col gap-1">
            <div className="group flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {col.name}
              </span>
              <button
                onClick={() => api.deleteCollection(col.id).then(load)}
                className="hidden text-[10px] text-zinc-600 hover:text-red-400 group-hover:block"
              >
                delete
              </button>
            </div>
            {requests.length === 0 && (
              <p className="pl-1 text-[11px] text-zinc-700">empty</p>
            )}
            {requests.map((req) => (
              <RequestRow
                key={req.id}
                req={req}
                expanded={expandedReq === req.id}
                onToggle={() => setExpandedReq(expandedReq === req.id ? null : req.id)}
                onRun={() => run(req)}
                running={running === req.id}
                result={results[req.id]}
                onChanged={load}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function RequestRow({
  req,
  expanded,
  onToggle,
  onRun,
  running,
  result,
  onChanged,
}: {
  req: SavedRequestSummary;
  expanded: boolean;
  onToggle: () => void;
  onRun: () => void;
  running: boolean;
  result?: RunSavedRequestResult;
  onChanged: () => void;
}) {
  const [assertions, setAssertions] = useState<AssertionSpec[]>(req.assertions);

  useEffect(() => setAssertions(req.assertions), [req.assertions]);

  async function saveAssertions() {
    await api.updateRequest(req.id, {
      name: req.name,
      endpointId: req.endpointId,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      assertions: assertions.filter((a) => a.type && a.operator),
    });
    onChanged();
  }

  const passCount = result?.assertions.filter((a) => a.passed).length ?? 0;
  const failCount = (result?.assertions.length ?? 0) - passCount;

  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={`rounded border px-1 py-0 font-mono text-[9px] font-bold ${methodBadge(req.method)}`}>
            {req.method}
          </span>
          <span className="truncate text-xs text-zinc-300">{req.name}</span>
        </button>
        {result && (
          <span
            className={`font-mono text-[10px] font-bold ${
              result.result.error || (result.result.status ?? 0) >= 400 || failCount > 0
                ? 'text-red-400'
                : 'text-emerald-400'
            }`}
          >
            {result.result.error ? 'ERR' : result.result.status}
            {result.assertions.length > 0 && ` ${passCount}/${result.assertions.length}✓`}
          </span>
        )}
        <button
          onClick={onRun}
          disabled={running}
          className="rounded bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {running ? '…' : '▶'}
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-zinc-800/70 p-2">
          <code className="break-all font-mono text-[10px] text-zinc-500">{req.url}</code>

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Assertions
            </span>
            {assertions.map((a, i) => (
              <div key={i} className="flex items-center gap-1">
                <select
                  value={a.type}
                  onChange={(e) =>
                    setAssertions(assertions.map((x, j) => (j === i ? { ...x, type: e.target.value as never } : x)))
                  }
                  className="rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 text-[10px]"
                >
                  {ASSERTION_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                {(a.type === 'jsonPath' || a.type === 'header') && (
                  <input
                    value={a.pathExpr ?? ''}
                    onChange={(e) =>
                      setAssertions(assertions.map((x, j) => (j === i ? { ...x, pathExpr: e.target.value } : x)))
                    }
                    placeholder={a.type === 'jsonPath' ? 'data.id' : 'content-type'}
                    className="w-20 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 font-mono text-[10px] placeholder:text-zinc-700"
                  />
                )}
                <select
                  value={a.operator}
                  onChange={(e) =>
                    setAssertions(assertions.map((x, j) => (j === i ? { ...x, operator: e.target.value as never } : x)))
                  }
                  className="rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 text-[10px]"
                >
                  {OPERATORS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                {a.operator !== 'exists' && (
                  <input
                    value={a.expected ?? ''}
                    onChange={(e) =>
                      setAssertions(assertions.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)))
                    }
                    placeholder="expected"
                    className="w-16 min-w-0 rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 font-mono text-[10px] placeholder:text-zinc-700"
                  />
                )}
                <button
                  onClick={() => setAssertions(assertions.filter((_, j) => j !== i))}
                  className="text-zinc-600 hover:text-red-400"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <button
                onClick={() => setAssertions([...assertions, { type: 'status', operator: 'eq', expected: '200' }])}
                className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-600"
              >
                + assertion
              </button>
              <button
                onClick={saveAssertions}
                className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-900"
              >
                save
              </button>
              <button
                onClick={() => api.deleteRequest(req.id).then(onChanged)}
                className="ml-auto text-[10px] text-zinc-600 hover:text-red-400"
              >
                delete request
              </button>
            </div>
          </div>

          {result && result.assertions.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {result.assertions.map((a, i) => (
                <div key={i} className={`font-mono text-[10px] ${a.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                  {a.passed ? '✓' : '✗'} {a.type}
                  {a.pathExpr ? `(${a.pathExpr})` : ''} {a.operator} {a.expected ?? ''} — got {a.actual ?? 'null'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
