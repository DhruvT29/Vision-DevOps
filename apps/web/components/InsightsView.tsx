'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { GraphPayload, InsightsPayload, ScanStatus } from '@vision/shared';
import { api } from '@/lib/api';
import { computeHealth } from '@/lib/health';
import { AppShell } from '@/components/AppShell';

const GRADE_STYLE: Record<string, string> = {
  A: 'border-emerald-500/40 text-emerald-400',
  B: 'border-sky-500/40 text-sky-400',
  C: 'border-amber-500/40 text-amber-400',
  D: 'border-orange-500/40 text-orange-400',
  F: 'border-rose-500/40 text-rose-400',
};

function timeAgo(iso?: string): string {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function InsightsView({ snapshotId }: { snapshotId: string }) {
  const [status, setStatus] = useState<ScanStatus>('pending');
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [insights, setInsights] = useState<InsightsPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const snap = await api.snapshot(snapshotId);
        if (cancelled) return;
        setStatus(snap.status);
        if (snap.status === 'completed') {
          const payload = await api.graph(snapshotId);
          if (cancelled) return;
          setGraph(payload);
          // git history read (and shallow-clone deepening) can take a moment
          const ins = await api.insights(snapshotId).catch(() => null);
          if (!cancelled) {
            setInsights(
              ins ?? {
                snapshotId,
                git: { available: false, reason: 'insights request failed', commitsAnalyzed: 0 },
                contributors: [],
                modules: [],
              },
            );
          }
        } else if (snap.status === 'failed') {
          setError(snap.error ?? 'Scan failed');
        } else {
          timer = setTimeout(poll, 800);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [snapshotId]);

  const health = useMemo(() => (graph ? computeHealth(graph) : null), [graph]);
  const depEdgeCount = useMemo(
    () =>
      graph?.edges.filter((e) => e.type === 'imports' || e.type === 'file-imports').length ?? 0,
    [graph],
  );
  const mostImported = useMemo(() => {
    if (!graph) return [];
    const inDeg = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.type !== 'imports' && e.type !== 'file-imports') continue;
      inDeg.set(e.targetId, (inDeg.get(e.targetId) ?? 0) + 1);
    }
    return graph.modules
      .map((m) => ({ module: m, count: inDeg.get(m.id) ?? 0 }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [graph]);

  if (error) {
    return (
      <AppShell snapshotId={snapshotId}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-red-400">Scan failed</p>
          <p className="max-w-lg text-center font-mono text-xs text-zinc-500">{error}</p>
          <Link href="/" className="text-sm text-sky-400 hover:underline">← back</Link>
        </div>
      </AppShell>
    );
  }

  if (!graph || !health) {
    return (
      <AppShell snapshotId={snapshotId}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200" />
          <p className="text-sm text-zinc-400">
            {status === 'running' ? 'Analyzing project…' : 'Starting scan…'}
          </p>
        </div>
      </AppShell>
    );
  }

  const maxCommits = Math.max(1, ...(insights?.modules.map((m) => m.commits) ?? [1]));
  const hot = insights?.modules.filter((m) => m.commits > 0).slice(0, 8) ?? [];

  return (
    <AppShell snapshotId={snapshotId} stats={graph.snapshot.stats}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
          {/* ── Health ── */}
          <section className="flex gap-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div
              className={`flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-xl border-2 bg-zinc-950 ${GRADE_STYLE[health.grade]}`}
            >
              <span className="text-4xl font-bold">{health.grade}</span>
              <span className="text-[10px] text-zinc-500">{health.score}/100</span>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-zinc-100">Codebase health</h2>
              <p className="mt-0.5 text-xs text-zinc-500">
                {graph.modules.length} modules · {depEdgeCount} dependencies ·{' '}
                {graph.endpoints.length} endpoints
              </p>
              {health.factors.length === 0 ? (
                <p className="mt-3 text-xs text-emerald-400">
                  No structural issues detected — no circular dependencies, hidden coupling, or
                  outsized modules.
                </p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {health.factors.map((f) => (
                    <li key={f.label} className="text-xs">
                      <span className="font-medium text-zinc-200">{f.label}</span>
                      <span className="ml-2 rounded bg-rose-950/60 px-1.5 py-0.5 text-[10px] text-rose-300">
                        −{f.penalty} pts
                      </span>
                      <p className="mt-0.5 break-words text-[11px] leading-relaxed text-zinc-500">
                        {f.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* ── Git activity ── */}
          {!insights ? (
            <section className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200" />
              <p className="text-xs text-zinc-400">Reading git history…</p>
            </section>
          ) : !insights.git.available ? (
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="text-sm font-semibold text-zinc-100">Activity & ownership</h2>
              <p className="mt-2 text-xs text-zinc-500">
                Git history unavailable — {insights.git.reason ?? 'unknown reason'}.
              </p>
            </section>
          ) : (
            <>
              <div className="grid gap-6 md:grid-cols-2">
                <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
                  <h2 className="text-sm font-semibold text-zinc-100">Hot modules</h2>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    by commits in the last {insights.git.commitsAnalyzed} commits
                    {insights.git.deepened && ' (history deepened from shallow clone)'}
                  </p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {hot.length === 0 && (
                      <li className="text-xs text-zinc-600">No module-owned files in history</li>
                    )}
                    {hot.map((m) => (
                      <li key={m.moduleId}>
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="truncate text-zinc-300">{m.name}</span>
                          <span className="shrink-0 text-[10px] text-zinc-500">
                            {m.commits} commits · {timeAgo(m.lastCommitAt)}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-amber-500 to-rose-500"
                            style={{ width: `${Math.max(4, (m.commits / maxCommits) * 100)}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
                  <h2 className="text-sm font-semibold text-zinc-100">Top contributors</h2>
                  <p className="mt-0.5 text-[11px] text-zinc-500">across the project root</p>
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {insights.contributors.length === 0 && (
                      <li className="text-xs text-zinc-600">No commits found</li>
                    )}
                    {insights.contributors.map((c) => (
                      <li key={c.name} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-zinc-300">{c.name}</span>
                        <span className="shrink-0 text-[10px] text-zinc-500">{c.commits} commits</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
                <h2 className="text-sm font-semibold text-zinc-100">Module ownership</h2>
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  who to ask about each module, from git blame-by-commit
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                        <th className="pb-2 pr-4 font-medium">Module</th>
                        <th className="pb-2 pr-4 font-medium">Commits</th>
                        <th className="pb-2 pr-4 font-medium">Last touched</th>
                        <th className="pb-2 font-medium">Top contributors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insights.modules.map((m) => (
                        <tr key={m.moduleId} className="border-b border-zinc-900 last:border-0">
                          <td className="py-2 pr-4 text-zinc-300">{m.name}</td>
                          <td className="py-2 pr-4 text-zinc-500">{m.commits}</td>
                          <td className="py-2 pr-4 text-zinc-500">{timeAgo(m.lastCommitAt)}</td>
                          <td className="py-2 text-zinc-500">
                            {m.contributors.length === 0
                              ? '—'
                              : m.contributors
                                  .map((c) => `${c.name} (${c.commits})`)
                                  .join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {/* ── Structure ── */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <h2 className="text-sm font-semibold text-zinc-100">Coupling hotspots</h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              most-depended-on modules — changes here ripple furthest
            </p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {mostImported.length === 0 && (
                <li className="text-xs text-zinc-600">No module dependencies in this snapshot</li>
              )}
              {mostImported.map((r) => (
                <li key={r.module.id} className="flex items-center justify-between gap-2 text-xs">
                  <Link
                    href={`/dependencies/${snapshotId}`}
                    className="truncate text-sky-300 transition hover:text-sky-200"
                    title="Open the dependency graph"
                  >
                    {r.module.name}
                  </Link>
                  <span className="shrink-0 text-[10px] text-zinc-500">
                    imported by {r.count} module{r.count === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
