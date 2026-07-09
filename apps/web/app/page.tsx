'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProjectSummary } from '@vision/shared';
import { api } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  const [engineOk, setEngineOk] = useState<boolean | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000'}/health`)
      .then((r) => setEngineOk(r.ok))
      .catch(() => setEngineOk(false));
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  async function openPath(path: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.openProject(path);
      router.push(`/graph/${res.snapshot.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function openExisting(project: ProjectSummary) {
    setBusy(true);
    setError(null);
    try {
      const snap = await api.latestSnapshot(project.id);
      if (snap.status === 'completed') router.push(`/graph/${snap.id}`);
      else await openPath(project.rootPath); // stale/failed → rescan
    } catch {
      await openPath(project.rootPath);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-10 px-6 py-16">
      <header className="flex flex-col items-center gap-3">
        <h1 className="text-6xl font-bold tracking-tight">Vision</h1>
        <p className="text-zinc-400">Project knowledge graph &amp; API testing workbench</p>
        <div className="flex items-center gap-2 rounded-full border border-zinc-800 px-3 py-1 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              engineOk === null ? 'bg-zinc-600' : engineOk ? 'bg-emerald-500' : 'bg-red-500'
            }`}
          />
          <span className="text-zinc-400">
            {engineOk === null ? 'checking engine…' : engineOk ? 'engine online' : 'engine offline'}
          </span>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <label className="text-sm font-medium text-zinc-300">Open a project directory</label>
        <div className="flex gap-2">
          <input
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && rootPath && !busy && openPath(rootPath)}
            placeholder="C:\path\to\your\project"
            spellCheck={false}
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          <button
            onClick={() => openPath(rootPath)}
            disabled={!rootPath || busy}
            className="rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:opacity-40"
          >
            {busy ? 'Scanning…' : 'Open'}
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </section>

      {projects.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-zinc-500">Recent projects</h2>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => openExisting(p)}
              disabled={busy}
              className="group flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition hover:border-zinc-700 hover:bg-zinc-900"
            >
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="font-mono text-xs text-zinc-500">{p.rootPath}</div>
              </div>
              <div className="flex gap-1.5">
                {p.detectedStacks.map((s, i) => (
                  <span
                    key={i}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400"
                  >
                    {s.kind}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </section>
      )}
    </main>
  );
}
