'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { ProjectBranchesResult, ProjectSummary } from '@vision/shared';
import { api } from '@/lib/api';

/**
 * Header dropdown to switch a GitHub project to another branch without going
 * back to the landing page. Picking a branch re-opens the repo on it (fetch
 * latest + fresh analysis) and navigates the current section to the new
 * snapshot — every page then updates through its own snapshot polling.
 * Renders nothing for local-path projects.
 */
export function BranchSwitcher({ snapshotId }: { snapshotId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [branches, setBranches] = useState<ProjectBranchesResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** branch we are currently switching to, while openGithub clones + rescans */
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.snapshot(snapshotId);
        const projects = await api.listProjects();
        const p = projects.find((x) => x.id === snap.projectId) ?? null;
        if (!cancelled) setProject(p);
      } catch {
        if (!cancelled) setProject(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshotId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setFilter('');
      filterRef.current?.focus();
    }
  }, [open]);

  // lazy branch list, fetched once on first open
  useEffect(() => {
    if (!open || branches || !project) return;
    let cancelled = false;
    setLoadError(null);
    api
      .projectBranches(project.id)
      .then((b) => {
        if (!cancelled) setBranches(b);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, branches, project]);

  if (!project || project.source !== 'github' || !project.repoUrl || !project.repoBranch) {
    return null;
  }
  const repoUrl = project.repoUrl;
  const current = project.repoBranch;

  async function switchTo(branch: string) {
    if (branch === current || switching) return;
    setSwitching(branch);
    setSwitchError(null);
    try {
      const res = await api.openGithub({ repoUrl, branch });
      const section = pathname.split('/')[1] || 'project';
      router.push(`/${section}/${res.snapshot.id}`);
    } catch (e) {
      setSwitchError(e instanceof Error ? e.message : String(e));
      setSwitching(null);
    }
  }

  const visible = (branches?.branches ?? []).filter((b) =>
    b.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!!switching}
        title={`Branch: ${current} — click to switch`}
        className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300 outline-none transition hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-wait"
      >
        <BranchIcon />
        <span className="max-w-44 truncate font-mono">
          {switching ? `switching to ${switching}…` : current}
        </span>
        {switching ? (
          <Spinner />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`h-3 w-3 text-zinc-500 transition-transform duration-150 ${
              open ? 'rotate-180' : ''
            }`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/50">
          {switching ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-400">
              <Spinner />
              Fetching <span className="font-mono text-zinc-200">{switching}</span> and
              re-analyzing…
            </div>
          ) : (
            <>
              <div className="border-b border-zinc-800 p-1.5">
                <input
                  ref={filterRef}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter branches…"
                  spellCheck={false}
                  className="w-full rounded-md border border-transparent bg-zinc-950 px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-700"
                />
              </div>
              {switchError && (
                <div className="border-b border-zinc-800 px-3 py-2 text-xs text-red-400">
                  {switchError}
                </div>
              )}
              {loadError ? (
                <div className="px-3 py-2.5 text-xs text-red-400">{loadError}</div>
              ) : !branches ? (
                <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-zinc-500">
                  <Spinner />
                  Loading branches…
                </div>
              ) : (
                <ul className="max-h-64 overflow-y-auto py-1">
                  {visible.length === 0 && (
                    <li className="px-3 py-2 text-xs text-zinc-500">No branches match</li>
                  )}
                  {visible.map((b) => (
                    <li key={b}>
                      <button
                        type="button"
                        onClick={() => void switchTo(b)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-xs transition ${
                          b === current
                            ? 'bg-zinc-800 text-zinc-100'
                            : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100'
                        }`}
                      >
                        <span className="truncate">{b}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {b === branches.defaultBranch && (
                            <span className="text-[10px] text-zinc-500">default</span>
                          )}
                          {b === current && (
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              className="h-3.5 w-3.5 text-emerald-400"
                            >
                              <path d="m5 13 4 4L19 7" />
                            </svg>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function BranchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-3.5 w-3.5 shrink-0 text-zinc-500"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 8.5v7M18 8.5a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={`shrink-0 animate-spin ${className ?? 'h-3 w-3 text-zinc-400'}`}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
