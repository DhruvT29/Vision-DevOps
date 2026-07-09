'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  CollectionsPayload,
  ScenarioRunResult,
  ScenarioSummary,
  VariableExtraction,
} from '@vision/shared';
import { api, onCollectionsChanged } from '@/lib/api';

export function ScenariosPane({ projectId, envId }: { projectId: string; envId: string }) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [requests, setRequests] = useState<CollectionsPayload['requests']>([]);
  const [newName, setNewName] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ScenarioRunResult>>({});
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [scn, cols] = await Promise.all([
      api.scenarios(projectId).catch(() => []),
      api.collections(projectId).catch(() => ({ collections: [], requests: [] })),
    ]);
    setScenarios(scn);
    setRequests(cols.requests);
  }, [projectId]);

  useEffect(() => {
    load();
    return onCollectionsChanged(load);
  }, [load]);

  async function create() {
    if (!newName.trim()) return;
    await api.createScenario(projectId, newName.trim());
    setNewName('');
    load();
  }

  async function run(id: string) {
    setRunning(id);
    try {
      const res = await api.runScenario(id, envId || undefined);
      setResults((prev) => ({ ...prev, [id]: res }));
    } finally {
      setRunning(null);
    }
  }

  const requestName = (id: string) => requests.find((r) => r.id === id)?.name ?? '(deleted)';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder="new scenario…"
          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
        <button
          onClick={create}
          disabled={!newName.trim()}
          className="rounded border border-zinc-700 px-2.5 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
        >
          +
        </button>
      </div>

      {scenarios.length === 0 && (
        <p className="text-xs text-zinc-600">
          No scenarios yet. A scenario chains saved requests — values extracted from one
          response become {'{{variables}}'} for the next.
        </p>
      )}

      {scenarios.map((scn) => {
        const result = results[scn.id];
        return (
          <div key={scn.id} className="rounded-lg border border-zinc-800/70 bg-zinc-900/40">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <button
                onClick={() => setExpanded(expanded === scn.id ? null : scn.id)}
                className="min-w-0 flex-1 truncate text-left text-xs font-medium text-zinc-200"
              >
                {scn.name}
                <span className="pl-1.5 text-[10px] text-zinc-600">{scn.steps.length} steps</span>
              </button>
              {result && (
                <span className={`text-[10px] font-bold ${result.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                  {result.passed ? 'PASSED' : 'FAILED'}
                </span>
              )}
              <button
                onClick={() => run(scn.id)}
                disabled={running === scn.id || scn.steps.length === 0}
                className="rounded bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {running === scn.id ? '…' : '▶'}
              </button>
            </div>

            {expanded === scn.id && (
              <ScenarioDetail
                scenario={scn}
                requests={requests}
                requestName={requestName}
                result={result}
                onChanged={load}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ScenarioDetail({
  scenario,
  requests,
  requestName,
  result,
  onChanged,
}: {
  scenario: ScenarioSummary;
  requests: CollectionsPayload['requests'];
  requestName: (id: string) => string;
  result?: ScenarioRunResult;
  onChanged: () => void;
}) {
  const [pickReq, setPickReq] = useState('');
  const [extractions, setExtractions] = useState<VariableExtraction[]>([]);

  async function addStep() {
    if (!pickReq) return;
    await api.addScenarioStep(
      scenario.id,
      pickReq,
      extractions.filter((e) => e.name && e.pathExpr),
    );
    setPickReq('');
    setExtractions([]);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-2 border-t border-zinc-800/70 p-2">
      {scenario.steps.map((step, i) => {
        const stepResult = result?.steps.find((s) => s.stepId === step.id);
        return (
          <div key={step.id} className="flex flex-col gap-0.5 rounded border border-zinc-800/60 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-zinc-600">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                {requestName(step.savedRequestId)}
              </span>
              {stepResult && (
                <span
                  className={`font-mono text-[10px] font-bold ${
                    stepResult.skipped
                      ? 'text-zinc-600'
                      : stepResult.result.error || (stepResult.result.status ?? 0) >= 400 || stepResult.assertions.some((a) => !a.passed)
                        ? 'text-red-400'
                        : 'text-emerald-400'
                  }`}
                >
                  {stepResult.skipped ? 'SKIP' : stepResult.result.error ? 'ERR' : stepResult.result.status}
                </span>
              )}
              <button
                onClick={() => api.deleteScenarioStep(step.id).then(onChanged)}
                className="text-zinc-600 hover:text-red-400"
              >
                ×
              </button>
            </div>
            {step.extractions.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-4">
                {step.extractions.map((ex, j) => (
                  <span key={j} className="rounded bg-zinc-800 px-1.5 py-0 font-mono text-[9px] text-sky-300">
                    {'{{' + ex.name + '}}'} ← {ex.pathExpr}
                  </span>
                ))}
              </div>
            )}
            {stepResult && Object.keys(stepResult.extracted).length > 0 && (
              <div className="pl-4 font-mono text-[9px] text-emerald-500/80">
                extracted: {JSON.stringify(stepResult.extracted)}
              </div>
            )}
            {stepResult?.assertions.filter((a) => !a.passed).map((a, j) => (
              <div key={j} className="pl-4 font-mono text-[9px] text-red-400">
                ✗ {a.type}
                {a.pathExpr ? `(${a.pathExpr})` : ''} {a.operator} {a.expected} — got {a.actual ?? 'null'}
              </div>
            ))}
          </div>
        );
      })}

      <div className="flex flex-col gap-1.5 rounded border border-dashed border-zinc-800 p-2">
        <select
          value={pickReq}
          onChange={(e) => setPickReq(e.target.value)}
          className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px]"
        >
          <option value="">add step: pick a saved request…</option>
          {requests.map((r) => (
            <option key={r.id} value={r.id}>
              {r.method} {r.name}
            </option>
          ))}
        </select>
        {pickReq && (
          <>
            {extractions.map((ex, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  value={ex.name}
                  onChange={(e) =>
                    setExtractions(extractions.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                  placeholder="var name"
                  className="w-24 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] placeholder:text-zinc-700"
                />
                <span className="text-[10px] text-zinc-600">←</span>
                <input
                  value={ex.pathExpr}
                  onChange={(e) =>
                    setExtractions(extractions.map((x, j) => (j === i ? { ...x, pathExpr: e.target.value } : x)))
                  }
                  placeholder="response path e.g. data.token"
                  className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] placeholder:text-zinc-700"
                />
                <button
                  onClick={() => setExtractions(extractions.filter((_, j) => j !== i))}
                  className="text-zinc-600 hover:text-red-400"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <button
                onClick={() => setExtractions([...extractions, { name: '', pathExpr: '' }])}
                className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-600"
              >
                + extract variable
              </button>
              <button
                onClick={addStep}
                className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-900"
              >
                add step
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
