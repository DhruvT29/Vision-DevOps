'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GithubPreflightResult, ProjectSummary } from '@vision/shared';
import { api } from '@/lib/api';
import { BranchSelect } from '@/components/BranchSelect';

type SourceMode = 'local' | 'github';

export default function Home() {
  const router = useRouter();
  const [engineOk, setEngineOk] = useState<boolean | null>(null);
  const [mode, setMode] = useState<SourceMode>('local');
  const [rootPath, setRootPath] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

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
      router.push(`/project/${res.snapshot.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function removeProject(project: ProjectSummary) {
    try {
      await api.deleteProject(project.id);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirmRemove(null);
    }
  }

  async function openExisting(project: ProjectSummary) {
    setBusy(true);
    setError(null);
    try {
      const snap = await api.latestSnapshot(project.id);
      if (snap.status === 'completed') {
        router.push(`/project/${snap.id}`);
        return;
      }
      // stale/failed → rescan from the original source
      if (project.source === 'github' && (project.repoCloneUrl || project.repoUrl)) {
        const res = await api.openGithub({
          repoUrl: project.repoCloneUrl ?? project.repoUrl!,
          branch: project.repoBranch,
        });
        router.push(`/project/${res.snapshot.id}`);
      } else {
        await openPath(project.rootPath);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-10 px-6 py-16">
      <header className="flex flex-col items-center gap-3">
        <h1 className="pl-[1.65em] text-6xl font-bold tracking-[1.65em]">VISION</h1>
        <div className="mt-9 flex items-center gap-2 rounded-full border border-zinc-800 px-3 py-1 text-xs">
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
        <div className="flex gap-1 self-center rounded-lg border border-zinc-800 p-0.5 text-sm">
          {(['local', 'github'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`rounded-md px-3 py-1 transition ${
                mode === m ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {m === 'local' ? 'Local path' : 'GitHub'}
            </button>
          ))}
        </div>

        {mode === 'local' ? (
          <>
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
          </>
        ) : (
          <GithubForm
            busy={busy}
            setBusy={setBusy}
            onOpened={(snapshotId) => router.push(`/project/${snapshotId}`)}
            error={error}
            setError={setError}
          />
        )}
        {mode === 'local' && error && <p className="text-sm text-red-400">{error}</p>}
      </section>

      {projects.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-zinc-500">Recent projects</h2>
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => !busy && openExisting(p)}
              onMouseLeave={() => setConfirmRemove((c) => (c === p.id ? null : c))}
              className="group flex cursor-pointer items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition hover:border-zinc-700 hover:bg-zinc-900"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  {p.source === 'github' && <GithubMark />}
                  <span className="truncate">{p.name}</span>
                  {p.source === 'github' && p.repoBranch && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                      {p.repoBranch}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-zinc-500">
                  {p.source === 'github' ? p.repoUrl ?? p.rootPath : p.rootPath}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 pl-3">
                {p.detectedStacks.map((s, i) => (
                  <span
                    key={i}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400"
                  >
                    {s.kind}
                  </span>
                ))}
                {confirmRemove === p.id ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeProject(p);
                    }}
                    title="Removes the project, its snapshots, environments, collections and scenarios from Vision. Files on disk are untouched."
                    className="rounded border border-red-500/40 bg-red-950/40 px-2 py-1 text-[10px] font-semibold text-red-300 transition hover:bg-red-950/70"
                  >
                    Remove?
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmRemove(p.id);
                    }}
                    aria-label={`Remove ${p.name} from history`}
                    title="Remove from history"
                    className="rounded p-1 text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-3.5 w-3.5"
                    >
                      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

function GithubForm({
  busy,
  setBusy,
  onOpened,
  error,
  setError,
}: {
  busy: boolean;
  setBusy: (b: boolean) => void;
  onOpened: (snapshotId: string) => void;
  error: string | null;
  setError: (e: string | null) => void;
}) {
  const [repoUrl, setRepoUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pre, setPre] = useState<GithubPreflightResult | null>(null);
  const [manualBranch, setManualBranch] = useState(false);
  const [branch, setBranch] = useState('');

  const looksLikeRepo = /github\.com[:/][^/]+\/[^/]+/i.test(repoUrl);

  async function loadBranches() {
    if (!looksLikeRepo || checking) return;
    setChecking(true);
    setError(null);
    setPre(null);
    setManualBranch(false);
    try {
      const result = await api.githubPreflight({
        repoUrl,
        token: showToken && token ? token : undefined,
      });
      setPre(result);
      if (result.access) {
        setBranch(result.defaultBranch);
        if (!result.usedSystemCredential) {
          // public or pasted-token access — no extra hint needed
        }
      } else {
        // no credential could reach it → reveal token field for a retry
        setShowToken(true);
      }
    } catch (e) {
      // network / rate-limit → degrade to manual branch + token
      setManualBranch(true);
      setShowToken(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.openGithub({
        repoUrl,
        branch: branch.trim() || undefined,
        token: showToken && token ? token : undefined,
      });
      onOpened(res.snapshot.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const hasAccess = pre?.access === true;
  const noAccess = pre?.access === false;
  const canOpen = looksLikeRepo && !busy && (hasAccess || manualBranch);

  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm font-medium text-zinc-300">Open a GitHub repository</label>
      <div className="flex gap-2">
        <input
          value={repoUrl}
          onChange={(e) => {
            setRepoUrl(e.target.value);
            setPre(null);
          }}
          onBlur={loadBranches}
          onKeyDown={(e) => e.key === 'Enter' && loadBranches()}
          placeholder="https://github.com/owner/repo  ·  git@github.com:owner/repo.git"
          spellCheck={false}
          className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
        <button
          onClick={loadBranches}
          disabled={!looksLikeRepo || checking}
          className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-200 transition hover:border-zinc-500 disabled:opacity-40"
        >
          {checking ? 'Checking…' : 'Load branches'}
        </button>
      </div>

      {/* Branch selector (access) or manual fallback */}
      {hasAccess && !manualBranch && pre.access && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">Branch</span>
            <BranchSelect
              branches={pre.branches}
              value={branch}
              defaultBranch={pre.defaultBranch}
              onChange={setBranch}
            />
          </div>
          {pre.usedSystemCredential && (
            <p className="text-xs text-emerald-400">
              ✓ access via your{pre.account ? ` @${pre.account}` : ' system'} Git credentials
            </p>
          )}
        </div>
      )}

      {manualBranch && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-400">Branch</span>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="leave blank for the default branch"
            spellCheck={false}
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
        </div>
      )}

      {/* No-access message */}
      {noAccess && pre.access === false && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-sm">
          <p className="font-medium text-amber-300">Ask owner to grant access to you</p>
          {pre.triedAccounts.length > 0 && (
            <p className="mt-1 text-xs text-amber-500/80">
              tried: {pre.triedAccounts.join(', ')}
            </p>
          )}
        </div>
      )}

      {/* Token disclosure */}
      {!showToken ? (
        <button
          onClick={() => setShowToken(true)}
          className="self-start text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
        >
          Use a token instead
        </button>
      ) : (
        <div className="flex flex-col gap-1">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Personal access token (optional)"
            spellCheck={false}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          <p className="text-[11px] text-zinc-600">
            Used once to clone — never stored. Your system Git accounts are tried first.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        onClick={open}
        disabled={!canOpen}
        className="self-start rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:opacity-40"
      >
        {busy ? 'Cloning…' : 'Open'}
      </button>
    </div>
  );
}

function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-zinc-400" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
