'use client';

import { useState } from 'react';
import type { Endpoint, EnvironmentSummary, ModuleNode } from '@vision/shared';
import { methodBadge } from '@/lib/method-colors';
import { TestPane } from '@/components/TestPane';

export function EndpointPanel({
  endpoint,
  module: mod,
  projectId,
  envs,
  envId,
  onClose,
}: {
  endpoint: Endpoint;
  module: ModuleNode | undefined;
  projectId: string;
  envs: EnvironmentSummary[];
  envId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'overview' | 'test'>('overview');

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[420px] flex-col gap-5 overflow-y-auto border-l border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className={`rounded border px-2 py-0.5 font-mono text-xs font-bold ${methodBadge(endpoint.method)}`}>
              {endpoint.method}
            </span>
            {mod && <span className="text-xs text-zinc-500">{mod.name}</span>}
          </div>
          <h2 className="break-all font-mono text-sm font-semibold text-zinc-100">
            {endpoint.fullPath}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Close"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
        {(['overview', 'test'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition ${
              tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'test' && (
        <TestPane endpoint={endpoint} projectId={projectId} envs={envs} envId={envId} />
      )}

      {tab === 'overview' && (
      <>
      <Section title="Auth">
        {endpoint.auth.required ? (
          <div className="flex flex-col gap-1.5">
            {endpoint.auth.guards.map((g, i) => (
              <code key={i} className="rounded bg-zinc-900 px-2 py-1 text-xs text-amber-300/90">
                {g}
              </code>
            ))}
            {endpoint.auth.roles.length > 0 && (
              <div className="flex gap-1.5 pt-1">
                {endpoint.auth.roles.map((r) => (
                  <span key={r} className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
                    {r}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="text-xs text-emerald-400">Public — no guards</span>
        )}
      </Section>

      {endpoint.params.length > 0 && (
        <Section title="Parameters">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="pb-1.5 font-medium">Name</th>
                <th className="pb-1.5 font-medium">In</th>
                <th className="pb-1.5 font-medium">Type</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {endpoint.params.map((p, i) => (
                <tr key={i} className="border-t border-zinc-900">
                  <td className="py-1.5 font-mono">{p.name}</td>
                  <td className="py-1.5">
                    <span className={p.source === 'path' ? 'text-sky-400' : 'text-violet-400'}>
                      {p.source}
                    </span>
                  </td>
                  <td className="py-1.5 font-mono text-zinc-400">{p.type ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {endpoint.bodyFields && (
        <Section title={`Body — ${endpoint.bodyTypeName ?? 'object'}`}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="pb-1.5 font-medium">Field</th>
                <th className="pb-1.5 font-medium">Type</th>
                <th className="pb-1.5 font-medium">Validators</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {endpoint.bodyFields.map((f, i) => (
                <tr key={i} className="border-t border-zinc-900">
                  <td className="py-1.5 font-mono">
                    {f.name}
                    {f.optional && <span className="text-zinc-600">?</span>}
                  </td>
                  <td className="py-1.5 font-mono text-zinc-400">{f.type}</td>
                  <td className="py-1.5 text-zinc-500">{f.validators.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Source">
        {endpoint.sourceUrl ? (
          <a
            href={endpoint.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-1.5 break-all rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-sky-400 transition hover:bg-zinc-800 hover:text-sky-300"
            title="Open on GitHub"
          >
            <span className="min-w-0 flex-1 break-all">
              {endpoint.filePath}:{endpoint.line}
            </span>
            <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
            </svg>
          </a>
        ) : (
          <code className="block break-all rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-400">
            {endpoint.filePath}:{endpoint.line}
          </code>
        )}
        <div className="pt-1 text-xs text-zinc-500">
          handler <code className="text-zinc-400">{endpoint.handlerName}()</code>
        </div>
      </Section>
      </>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}
