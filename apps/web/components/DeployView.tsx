'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  DeployEvent,
  DeploymentDetail,
  DeploymentStepResult,
  DeploymentStatus,
  DeploymentSummary,
  DeployStep,
  DeployTargetSummary,
  DeployUploadConfig,
  ParsedDeployScript,
  ParseScriptRequest,
  ProjectSummary,
  ServerSummary,
  SnapshotSummary,
} from '@vision/shared';
import { api, streamDeployment } from '@/lib/api';
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILES,
  bookmyfreshTemplate,
} from '@/lib/deploy-template';
import { AppShell } from '@/components/AppShell';
import { BranchSelect } from '@/components/BranchSelect';
import { Spinner } from '@/components/BranchSwitcher';

// ── shared bits ───────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<DeploymentStatus, string> = {
  running: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  succeeded: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  failed: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  cancelled: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
};

const STEP_ICON: Record<DeploymentStepResult['status'], string> = {
  pending: '○',
  running: '◐',
  succeeded: '✔',
  failed: '✖',
  skipped: '–',
};
const STEP_COLOR: Record<DeploymentStepResult['status'], string> = {
  pending: 'text-zinc-600',
  running: 'text-sky-400 animate-pulse',
  succeeded: 'text-emerald-400',
  failed: 'text-rose-400',
  skipped: 'text-zinc-600',
};

function fmtDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function StatusChip({ status }: { status: DeploymentStatus }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

// ── live run state ────────────────────────────────────────────────────────────

interface RunState {
  deploymentId: string;
  targetName: string;
  steps: DeploymentStepResult[];
  log: string;
  status: DeploymentStatus;
  progress?: { stepIndex: number; sent: number; total: number };
  /** set while the run is paused awaiting a Yes/No answer */
  prompt?: { stepIndex: number; message: string; defaultYes: boolean };
  error?: string;
  startedAt: number;
}

function applyEvent(run: RunState, ev: DeployEvent): RunState {
  switch (ev.type) {
    case 'log':
      return { ...run, log: run.log + ev.chunk };
    case 'step': {
      const steps = run.steps.slice();
      if (steps[ev.stepIndex]) {
        steps[ev.stepIndex] = {
          ...steps[ev.stepIndex],
          status: ev.status,
          exitCode: ev.exitCode ?? steps[ev.stepIndex].exitCode,
          durationMs: ev.durationMs ?? steps[ev.stepIndex].durationMs,
        };
      }
      return { ...run, steps };
    }
    case 'progress':
      return { ...run, progress: { stepIndex: ev.stepIndex, sent: ev.sentBytes, total: ev.totalBytes } };
    case 'prompt':
      return {
        ...run,
        prompt: { stepIndex: ev.stepIndex, message: ev.message, defaultYes: ev.defaultYes },
      };
    case 'prompt-resolved':
      return { ...run, prompt: undefined };
    case 'done':
      return { ...run, status: ev.status, error: ev.error, progress: undefined, prompt: undefined };
  }
}

// ── main ────────────────────────────────────────────────────────────────────

export function DeployView({ snapshotId }: { snapshotId: string }) {
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [targets, setTargets] = useState<DeployTargetSummary[]>([]);
  const [history, setHistory] = useState<DeploymentSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showServers, setShowServers] = useState(false);
  const [editing, setEditing] = useState<DeployTargetSummary | 'new' | null>(null);
  const [confirming, setConfirming] = useState<DeployTargetSummary | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [viewingHistory, setViewingHistory] = useState<DeploymentDetail | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);

  const reloadTargets = useCallback(async (pid: string) => {
    const [t, h] = await Promise.all([api.deployTargets(pid), api.deployments(pid, 20)]);
    setTargets(t);
    setHistory(h);
    return t;
  }, []);

  const reloadServers = useCallback(async () => {
    setServers(await api.servers());
  }, []);

  // resolve project + initial loads
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.snapshot(snapshotId);
        if (cancelled) return;
        setSnapshot(snap);
        setProjectId(snap.projectId);
        // the project's rootPath is the natural default for the upload source
        const proj = (await api.listProjects()).find((p) => p.id === snap.projectId);
        if (!cancelled && proj) {
          setProject(proj);
          setRootPath(proj.rootPath);
        }
        await reloadServers();
        const t = await reloadTargets(snap.projectId);
        if (cancelled) return;
        // reattach to any target mid-deploy (refresh-safe via SSE replay)
        const running = t.find((x) => x.lastDeployment?.status === 'running');
        if (running?.lastDeployment) void attach(running.lastDeployment.id, running.name);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      unsubRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotId]);

  // open (or reopen) the SSE stream for a deployment
  const attach = useCallback(
    async (deploymentId: string, targetName: string) => {
      unsubRef.current?.();
      const detail = await api.deployment(deploymentId).catch(() => null);
      setRun({
        deploymentId,
        targetName,
        steps: detail?.steps ?? [],
        log: '', // the stream replays the full log, so start empty to avoid doubling
        status: detail?.status ?? 'running',
        startedAt: detail ? new Date(detail.startedAt).getTime() : Date.now(),
      });
      unsubRef.current = streamDeployment(
        deploymentId,
        (ev) => {
          setRun((r) => (r && r.deploymentId === deploymentId ? applyEvent(r, ev) : r));
          if (ev.type === 'done' && projectId) void reloadTargets(projectId);
        },
        () => setBanner('Log stream disconnected — reopen the page to reattach.'),
      );
    },
    [projectId, reloadTargets],
  );

  async function doDeploy(target: DeployTargetSummary) {
    setConfirming(null);
    setBanner(null);
    try {
      const { deploymentId } = await api.startDeploy(target.id);
      await attach(deploymentId, target.name);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  async function stopRun() {
    if (!run) return;
    try {
      await api.cancelDeployment(run.deploymentId);
    } catch {
      /* already finished */
    }
  }

  // answer a paused prompt; the SSE `prompt-resolved` frame clears the card
  async function respondPrompt(stepIndex: number, answer: boolean) {
    if (!run) return;
    try {
      await api.respondDeployment(run.deploymentId, stepIndex, answer);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeTarget(target: DeployTargetSummary) {
    if (!projectId) return;
    try {
      await api.deleteDeployTarget(target.id);
      await reloadTargets(projectId);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  if (loadError) {
    return (
      <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-rose-400">Could not load deployment settings</p>
          <p className="max-w-lg text-center font-mono text-xs text-zinc-500">{loadError}</p>
          <Link href="/" className="text-sm text-sky-400 hover:underline">← back</Link>
        </div>
      </AppShell>
    );
  }

  if (!projectId) {
    return (
      <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200" />
          <p className="text-sm text-zinc-400">Loading…</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
      <div className="flex min-h-0 flex-1">
        {/* left: targets + history */}
        <div className="flex w-1/2 min-w-0 flex-col overflow-y-auto border-r border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
            <div>
              <h1 className="text-sm font-semibold text-zinc-100">Deployment</h1>
              <p className="text-xs text-zinc-500">Push this project to a server over SSH</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowServers(true)}
                className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
              >
                Servers ({servers.length})
              </button>
              <button
                onClick={() => setEditing('new')}
                disabled={servers.length === 0}
                title={servers.length === 0 ? 'Add a server first' : undefined}
                className="rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40"
              >
                + Target
              </button>
            </div>
          </div>

          {banner && (
            <div className="mx-5 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {banner}
            </div>
          )}

          <div className="flex flex-col gap-3 p-5">
            {targets.length === 0 && (
              <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
                {servers.length === 0
                  ? 'Add a server, then create a deploy target.'
                  : 'No deploy targets yet. Create one to get started.'}
              </div>
            )}
            {targets.map((t) => (
              <TargetCard
                key={t.id}
                target={t}
                busy={run?.status === 'running' && run.targetName === t.name}
                onDeploy={() => setConfirming(t)}
                onEdit={() => setEditing(t)}
                onDelete={() => removeTarget(t)}
              />
            ))}
          </div>

          {history.length > 0 && (
            <div className="border-t border-zinc-800 p-5">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                History
              </h2>
              <div className="flex flex-col gap-1">
                {history.map((d) => (
                  <button
                    key={d.id}
                    onClick={async () => setViewingHistory(await api.deployment(d.id))}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-zinc-800/60"
                  >
                    <span className="flex items-center gap-2">
                      <StatusChip status={d.status} />
                      <span className="text-zinc-300">{d.targetName}</span>
                    </span>
                    <span className="text-zinc-500">
                      {fmtDuration(d.durationMs)} · {timeAgo(d.startedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* right: live console */}
        <div className="flex w-1/2 min-w-0 flex-col">
          {run ? (
            <RunConsole
              run={run}
              onStop={stopRun}
              onClose={() => setRun(null)}
              onRespond={respondPrompt}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <RocketGlyph />
              <p className="text-sm text-zinc-400">No active deployment</p>
              <p className="max-w-xs text-xs text-zinc-600">
                Pick a target and hit Deploy — logs stream here live.
              </p>
            </div>
          )}
        </div>
      </div>

      {showServers && (
        <ServerManager
          servers={servers}
          onClose={() => setShowServers(false)}
          onChange={reloadServers}
        />
      )}
      {editing && (
        <TargetEditor
          projectId={projectId}
          project={project}
          rootPathDefault={rootPath}
          servers={servers}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reloadTargets(projectId);
          }}
        />
      )}
      {confirming && (
        <ConfirmDialog
          target={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => doDeploy(confirming)}
        />
      )}
      {viewingHistory && (
        <HistoryDetail detail={viewingHistory} onClose={() => setViewingHistory(null)} />
      )}
    </AppShell>
  );
}

// ── target card ───────────────────────────────────────────────────────────────

function TargetCard({
  target,
  busy,
  onDeploy,
  onEdit,
  onDelete,
}: {
  target: DeployTargetSummary;
  busy: boolean;
  onDeploy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">{target.name}</h3>
            {target.branch && (
              <span
                title="Deploys this branch fetched fresh from the git remote"
                className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300"
              >
                ⎇ {target.branch}
              </span>
            )}
            {target.scriptPath && (
              <span
                title={`Imported from ${target.scriptPath} — open Edit → Import from script to re-sync`}
                className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
              >
                ⤓ {target.scriptPath.split(/[\\/]/).pop()}
              </span>
            )}
            {(target.localPre.length > 0 || target.localPost.length > 0) && (
              <span
                title={`${target.localPre.length + target.localPost.length} step(s) run on this machine`}
                className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
              >
                {target.localPre.length + target.localPost.length} local
              </span>
            )}
            {target.lastDeployment && <StatusChip status={target.lastDeployment.status} />}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">
            {target.username}@{target.host} · {target.workingDir}
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            {target.preflight.length > 0 && `${target.preflight.length} preflight · `}
            {target.upload ? 'upload on · ' : ''}
            {target.steps.length} step{target.steps.length === 1 ? '' : 's'}
            {target.healthUrl && ' · health check'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={onEdit}
            className="rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-800"
          >
            Edit
          </button>
          {confirmDel ? (
            <button
              onClick={onDelete}
              onMouseLeave={() => setConfirmDel(false)}
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300"
            >
              Remove?
            </button>
          ) : (
            <button
              onClick={() => setConfirmDel(true)}
              className="rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 transition hover:text-rose-300"
            >
              ✕
            </button>
          )}
          <button
            onClick={onDeploy}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── live console ──────────────────────────────────────────────────────────────

function RunConsole({
  run,
  onStop,
  onClose,
  onRespond,
}: {
  run: RunState;
  onStop: () => void;
  onClose: () => void;
  onRespond: (stepIndex: number, answer: boolean) => void;
}) {
  const logRef = useRef<HTMLPreElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (run.status !== 'running') return;
    const t = setInterval(() => setElapsed(Date.now() - run.startedAt), 500);
    return () => clearInterval(t);
  }, [run.status, run.startedAt]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.log]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <StatusChip status={run.status} />
          <span className="text-sm font-medium text-zinc-200">{run.targetName}</span>
          <span className="font-mono text-xs text-zinc-500">
            {run.status === 'running' ? fmtDuration(elapsed) : ''}
          </span>
        </div>
        <div className="flex gap-2">
          {run.status === 'running' ? (
            <button
              onClick={onStop}
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300 transition hover:bg-rose-500/20"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* step rows */}
      <div className="max-h-56 shrink-0 overflow-y-auto border-b border-zinc-800 px-5 py-2">
        {run.steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
            <span className={`w-4 text-center ${STEP_COLOR[s.status]}`}>{STEP_ICON[s.status]}</span>
            <span className={s.status === 'skipped' ? 'text-zinc-600' : 'text-zinc-300'}>
              {s.name}
            </span>
            {s.phase !== 'step' && (
              <span
                className={`rounded px-1 text-[9px] uppercase ${
                  s.phase === 'local-pre' || s.phase === 'local-post'
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-zinc-800 text-zinc-500'
                }`}
              >
                {s.phase === 'local-pre' || s.phase === 'local-post' ? 'local' : s.phase}
              </span>
            )}
            <span className="ml-auto font-mono text-[10px] text-zinc-600">
              {run.progress && run.progress.stepIndex === i
                ? `${Math.round((run.progress.sent / Math.max(run.progress.total, 1)) * 100)}%`
                : fmtDuration(s.durationMs)}
              {s.exitCode !== undefined && s.exitCode !== 0 ? ` · exit ${s.exitCode}` : ''}
            </span>
          </div>
        ))}
      </div>

      {/* the run is paused until this is answered */}
      {run.prompt && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-5 py-3">
          <p className="mb-2 flex items-center gap-2 text-xs text-amber-200">
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide">
              waiting for you
            </span>
            {run.prompt.message}
          </p>
          <div className="flex gap-2">
            <button
              autoFocus={run.prompt.defaultYes}
              onClick={() => onRespond(run.prompt!.stepIndex, true)}
              className={`rounded-lg px-3 py-1.5 text-xs transition ${
                run.prompt.defaultYes
                  ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/50 hover:bg-emerald-500/30'
                  : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              Yes
            </button>
            <button
              autoFocus={!run.prompt.defaultYes}
              onClick={() => onRespond(run.prompt!.stepIndex, false)}
              className={`rounded-lg px-3 py-1.5 text-xs transition ${
                run.prompt.defaultYes
                  ? 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                  : 'bg-zinc-700/60 text-zinc-100 ring-1 ring-zinc-500 hover:bg-zinc-700'
              }`}
            >
              No
            </button>
          </div>
        </div>
      )}

      {/* log */}
      <pre
        ref={logRef}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-zinc-950 px-5 py-3 font-mono text-[11px] leading-relaxed text-zinc-400"
      >
        {run.log || 'Waiting for output…'}
      </pre>

      {run.status !== 'running' && run.error && (
        <div className="border-t border-zinc-800 bg-rose-500/5 px-5 py-2 text-xs text-rose-300">
          {run.error}
        </div>
      )}
    </div>
  );
}

function HistoryDetail({ detail, onClose }: { detail: DeploymentDetail; onClose: () => void }) {
  return (
    <Modal onClose={onClose} wide>
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <StatusChip status={detail.status} />
          <span className="text-sm font-medium text-zinc-200">{detail.targetName}</span>
          <span className="text-xs text-zinc-500">
            {fmtDuration(detail.durationMs)} · {timeAgo(detail.startedAt)}
          </span>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
          ✕
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto border-b border-zinc-800 px-5 py-2">
        {detail.steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
            <span className={`w-4 text-center ${STEP_COLOR[s.status]}`}>{STEP_ICON[s.status]}</span>
            <span className={s.status === 'skipped' ? 'text-zinc-600' : 'text-zinc-300'}>
              {s.name}
            </span>
            <span className="ml-auto font-mono text-[10px] text-zinc-600">
              {fmtDuration(s.durationMs)}
              {s.exitCode !== undefined && s.exitCode !== 0 ? ` · exit ${s.exitCode}` : ''}
            </span>
          </div>
        ))}
      </div>
      <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words bg-zinc-950 px-5 py-3 font-mono text-[11px] leading-relaxed text-zinc-400">
        {detail.log || '(no output)'}
        {detail.truncated && '\n… [truncated]'}
      </pre>
    </Modal>
  );
}

// ── confirm dialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: DeployTargetSummary;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal onClose={onCancel} wide>
      <div className="border-b border-zinc-800 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-100">
          Deploy <span className="text-emerald-400">{target.name}</span>?
        </h3>
        <p className="mt-1 font-mono text-xs text-zinc-500">
          {target.username}@{target.host} · {target.workingDir}
        </p>
      </div>
      <div className="max-h-[55vh] overflow-y-auto px-5 py-3 text-xs">
        {target.localPre.length > 0 && (
          <LocalSection title="Before packaging — ON THIS MACHINE" steps={target.localPre} />
        )}
        {target.preflight.length > 0 && (
          <Section title="Preflight (must pass before anything changes)">
            {target.preflight.map((c, i) => (
              <CommandLine key={i}>{c}</CommandLine>
            ))}
          </Section>
        )}
        {target.upload && (
          <Section title="Package & upload">
            {target.branch ? (
              <>
                <p className="text-zinc-400">
                  source:{' '}
                  <span className="font-mono text-sky-300">branch {target.branch}</span>{' '}
                  <span className="text-zinc-500">— fetched fresh from the git remote</span>
                </p>
                <p className="text-zinc-600">
                  local dir <span className="font-mono">{target.upload.localDir}</span> is
                  ignored while a branch is set
                </p>
              </>
            ) : (
              <p className="text-zinc-500">
                from <span className="font-mono text-zinc-400">{target.upload.localDir}</span>
              </p>
            )}
            <p className="text-zinc-500">
              → <span className="font-mono text-zinc-400">{target.upload.remoteZipPath}</span>
            </p>
            <p className="mt-1 text-zinc-600">
              excludes: {[...target.upload.excludeDirs, ...target.upload.excludeFiles].join(', ')}
            </p>
          </Section>
        )}
        <Section title={`Steps (${target.steps.length}) — run in ${target.workingDir}`}>
          {target.steps.map((s, i) => (
            <div key={i} className="mb-1.5">
              {s.name && <p className="text-zinc-400">{s.name}</p>}
              <CommandLine>{s.command}</CommandLine>
            </div>
          ))}
        </Section>
        {target.healthUrl && (
          <Section title="Health check">
            <CommandLine>GET {target.healthUrl}</CommandLine>
          </Section>
        )}
        {target.localPost.length > 0 && (
          <LocalSection title="After the health check — ON THIS MACHINE" steps={target.localPost} />
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
        <button
          onClick={onCancel}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
        >
          Deploy
        </button>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      {children}
    </div>
  );
}

function CommandLine({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mb-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-zinc-950 px-2 py-1 font-mono text-[11px] text-emerald-300/90">
      {children}
    </pre>
  );
}

/** Local steps get their own visual treatment — they run on the user's machine. */
function LocalSection({ title, steps }: { title: string; steps: DeployStep[] }) {
  return (
    <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
        {title}
      </p>
      {steps.map((s, i) => {
        const off = s.enabled === false;
        return (
          <div key={i} className="mb-1.5">
            <p className={off ? 'text-zinc-600 line-through' : 'text-zinc-400'}>
              {s.name ?? `Local step ${i + 1}`}
              {off && <span className="ml-1 text-[10px] text-zinc-600">(switched off)</span>}
              {/\bgit\s+push\b/.test(s.command) && (
                <span className="ml-1.5 rounded bg-rose-500/15 px-1 py-0.5 text-[9px] font-medium text-rose-300">
                  pushes to git
                </span>
              )}
            </p>
            {s.confirmBefore && (
              <p className="text-[10px] text-amber-300/80">asks first: “{s.confirmBefore}”</p>
            )}
            <pre className="mb-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-zinc-950 px-2 py-1 font-mono text-[11px] text-sky-300/90">
              {s.command}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

// ── target editor ─────────────────────────────────────────────────────────────

function TargetEditor({
  projectId,
  project,
  rootPathDefault,
  servers,
  initial,
  onClose,
  onSaved,
}: {
  projectId: string;
  project?: ProjectSummary | null;
  rootPathDefault?: string;
  servers: ServerSummary[];
  initial: DeployTargetSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [serverId, setServerId] = useState(initial?.serverId ?? servers[0]?.id ?? '');
  const [workingDir, setWorkingDir] = useState(initial?.workingDir ?? '');
  const [preflight, setPreflight] = useState<string[]>(initial?.preflight ?? []);
  const [uploadOn, setUploadOn] = useState(!!initial?.upload);
  const [upload, setUpload] = useState<DeployUploadConfig>(
    initial?.upload ?? {
      localDir: rootPathDefault ?? '',
      excludeDirs: DEFAULT_EXCLUDE_DIRS,
      excludeFiles: DEFAULT_EXCLUDE_FILES,
      remoteZipPath: '~/vision-deploy.zip',
    },
  );
  const [branch, setBranch] = useState(initial?.branch ?? '');
  const [steps, setSteps] = useState<DeployStep[]>(initial?.steps ?? [{ command: '' }]);
  const [localPre, setLocalPre] = useState<DeployStep[]>(initial?.localPre ?? []);
  const [localPost, setLocalPost] = useState<DeployStep[]>(initial?.localPost ?? []);
  const [scriptPath, setScriptPath] = useState(initial?.scriptPath ?? '');
  const [healthUrl, setHealthUrl] = useState(initial?.healthUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [parsed, setParsed] = useState<ParsedDeployScript | null>(null);

  // branch dropdown options for github projects; on failure (or local
  // projects) the field falls back to a plain text input
  const isGithub = project?.source === 'github';
  const [branchOpts, setBranchOpts] = useState<string[] | null>(null);
  const [branchDefault, setBranchDefault] = useState<string | undefined>(undefined);
  const [branchOptsFailed, setBranchOptsFailed] = useState(false);
  useEffect(() => {
    if (!isGithub || !project) return;
    let cancelled = false;
    api
      .projectBranches(project.id)
      .then((b) => {
        if (cancelled) return;
        setBranchOpts(b.branches);
        setBranchDefault(b.defaultBranch);
      })
      .catch(() => {
        if (!cancelled) setBranchOptsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isGithub, project]);

  function loadTemplate() {
    const tpl = bookmyfreshTemplate(upload.localDir || rootPathDefault || '');
    setWorkingDir(tpl.workingDir);
    setPreflight(tpl.preflight);
    setUploadOn(true);
    setUpload({ ...tpl.upload, localDir: upload.localDir || rootPathDefault || tpl.upload.localDir });
    setSteps(tpl.steps);
    setHealthUrl(tpl.healthUrl ?? '');
    if (!name) setName('staging');
  }

  /** Fill every field from a parsed deploy script, for review before saving. */
  function applyParsed(p: ParsedDeployScript, sourcePath: string) {
    if (p.workingDir) setWorkingDir(p.workingDir);
    setPreflight(p.preflight);
    if (p.upload) {
      setUploadOn(true);
      setUpload({ ...p.upload, localDir: p.upload.localDir || rootPathDefault || '' });
    }
    setSteps(p.steps.length ? p.steps : [{ command: '' }]);
    setLocalPre(p.localPre);
    setLocalPost(p.localPost);
    setHealthUrl(p.healthUrl ?? '');
    setScriptPath(sourcePath);
    setParsed(p);
    // preselect the registered server matching the script's host, if any
    const match = servers.find((s) => s.host === p.detected.host);
    if (match) setServerId(match.id);
    if (!name && p.detected.expectedBranch) setName(p.detected.expectedBranch);
  }

  async function save() {
    setError(null);
    if (!name.trim() || !serverId || !workingDir.trim()) {
      setError('Name, server and working directory are required.');
      return;
    }
    const cleanSteps = steps.filter((s) => s.command.trim().length > 0);
    if (cleanSteps.length === 0) {
      setError('Add at least one step.');
      return;
    }
    if (uploadOn && !upload.localDir.trim()) {
      setError('Upload is on but no local directory is set.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        serverId,
        workingDir: workingDir.trim(),
        preflight: preflight.filter((p) => p.trim().length > 0),
        upload: uploadOn ? upload : null,
        branch: branch.trim() || null,
        steps: cleanSteps,
        localPre: localPre.filter((s) => s.command.trim().length > 0),
        localPost: localPost.filter((s) => s.command.trim().length > 0),
        scriptPath: scriptPath.trim() || null,
        healthUrl: healthUrl.trim() || null,
      };
      if (initial) await api.updateDeployTarget(initial.id, body);
      else await api.createDeployTarget(projectId, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-100">
          {initial ? 'Edit target' : 'New deploy target'}
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImporting(true)}
            className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-300 transition hover:bg-sky-500/20"
          >
            Import from script
          </button>
          <button
            onClick={loadTemplate}
            className="rounded-lg border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-800"
          >
            Load BookMyFresh template
          </button>
        </div>
      </div>

      {importing && (
        <ImportScriptDialog
          initialPath={scriptPath}
          onClose={() => setImporting(false)}
          onParsed={(p, path) => {
            applyParsed(p, path);
            setImporting(false);
          }}
        />
      )}

      <div className="max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4">
        {parsed && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2.5 text-[11px]">
            <p className="mb-1 text-sky-300">
              Imported from <span className="font-mono">{scriptPath.split(/[\\/]/).pop()}</span> —{' '}
              {parsed.steps.length} remote, {parsed.localPre.length} local pre,{' '}
              {parsed.localPost.length} local post. Review below, then save.
            </p>
            {parsed.detected.host && (
              <p className="text-zinc-400">
                script targets{' '}
                <span className="font-mono text-zinc-300">
                  {parsed.detected.username}@{parsed.detected.host}
                </span>{' '}
                —{' '}
                {servers.some((s) => s.host === parsed.detected.host) ? (
                  <span className="text-emerald-400">matching server selected</span>
                ) : (
                  <span className="text-amber-400">
                    no registered server has that host; pick or add one above
                  </span>
                )}
              </p>
            )}
            {parsed.warnings.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-amber-300/90">
                {parsed.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="staging"
              className={inputCls}
            />
          </Field>
          <Field label="Server">
            <select value={serverId} onChange={(e) => setServerId(e.target.value)} className={inputCls}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.username}@{s.host})
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Working directory (remote)">
          <input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/var/www/app"
            className={`${inputCls} font-mono`}
          />
        </Field>

        <StringListField
          label="Preflight commands (each must exit 0 before deploying)"
          values={preflight}
          onChange={setPreflight}
          placeholder="test -d /var/www/app/backend"
        />

        <div className="rounded-lg border border-zinc-800 p-3">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={uploadOn} onChange={(e) => setUploadOn(e.target.checked)} />
            Package & upload local files before running steps
          </label>
          {uploadOn && (
            <div className="mt-3 space-y-3">
              <Field label="Local directory to zip">
                <input
                  value={upload.localDir}
                  onChange={(e) => setUpload({ ...upload, localDir: e.target.value })}
                  placeholder="C:\path\to\project"
                  className={`${inputCls} font-mono`}
                />
              </Field>
              <div>
                <Field label="Branch (optional)">
                  {isGithub && !branchOptsFailed ? (
                    branchOpts ? (
                      <div className="flex">
                        <BranchSelect
                          branches={branchOpts}
                          value={branch}
                          defaultBranch={branchDefault}
                          onChange={setBranch}
                          emptyOption="No branch — zip the directory as-is"
                          placeholder="no branch (zip directory as-is)"
                          triggerClassName={`${inputCls} font-mono`}
                        />
                      </div>
                    ) : (
                      <div className={`${inputCls} flex items-center justify-center`}>
                        <Spinner className="h-4 w-4 text-zinc-500" />
                      </div>
                    )
                  ) : (
                    <input
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      placeholder="staging-deploy"
                      spellCheck={false}
                      className={`${inputCls} font-mono`}
                    />
                  )}
                </Field>
                <p className="mt-1 text-[11px] text-zinc-600">
                  Deploys this branch fetched fresh from the git remote — the local
                  directory above is ignored while a branch is set. Leave empty to zip the
                  directory as-is.
                </p>
              </div>
              <Field label="Remote zip path">
                <input
                  value={upload.remoteZipPath}
                  onChange={(e) => setUpload({ ...upload, remoteZipPath: e.target.value })}
                  className={`${inputCls} font-mono`}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Exclude dirs (comma-sep)">
                  <input
                    value={upload.excludeDirs.join(', ')}
                    onChange={(e) =>
                      setUpload({ ...upload, excludeDirs: splitCsv(e.target.value) })
                    }
                    className={`${inputCls} font-mono`}
                  />
                </Field>
                <Field label="Exclude files (comma-sep)">
                  <input
                    value={upload.excludeFiles.join(', ')}
                    onChange={(e) =>
                      setUpload({ ...upload, excludeFiles: splitCsv(e.target.value) })
                    }
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </div>
            </div>
          )}
        </div>

        <StepsField
          steps={localPre}
          onChange={setLocalPre}
          local
          label="Local pre-deploy steps (before packaging)"
          placeholder='git -C "C:\path\to\repo" branch --show-current'
        />

        <StepsField steps={steps} onChange={setSteps} label="Remote steps (run in order on the server)" />

        <StepsField
          steps={localPost}
          onChange={setLocalPost}
          local
          label="Local post-deploy steps (after the health check)"
          placeholder="git push origin main"
        />

        <Field label="Health check URL (optional)">
          <input
            value={healthUrl}
            onChange={(e) => setHealthUrl(e.target.value)}
            placeholder="https://staging.example.com/api/health"
            className={`${inputCls} font-mono`}
          />
        </Field>

        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
        <button
          onClick={onClose}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-zinc-100 px-4 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save target'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Import a deploy target from a PowerShell deploy script — by path on this
 * machine (re-syncable) or by uploading the file (one-shot). The script is
 * parsed statically by the engine; it is never executed.
 */
function ImportScriptDialog({
  initialPath,
  onClose,
  onParsed,
}: {
  initialPath?: string;
  onClose: () => void;
  onParsed: (p: ParsedDeployScript, path: string) => void;
}) {
  const [path, setPath] = useState(initialPath ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(body: ParseScriptRequest, sourcePath: string) {
    setBusy(true);
    setError(null);
    try {
      onParsed(await api.parseDeployScript(body), sourcePath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="border-b border-zinc-800 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-100">Import from deploy script</h3>
      </div>
      <div className="space-y-4 px-5 py-4">
        <p className="text-[11px] text-zinc-500">
          The <span className="font-mono">.ps1</span> is read and parsed — never executed. Its
          remote bash block becomes the steps; local/interactive phases become local steps you can
          review. Any PEM path inside is ignored; the server and key stay as you configured them.
        </p>

        <Field label="Path to the script on this machine">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && path.trim() && !busy) void run({ path: path.trim() }, path.trim());
            }}
            placeholder="C:\Data Bank\Ultron\Codes\keystride\annpriya\scripts\deploy-staging.ps1"
            spellCheck={false}
            className={`${inputCls} font-mono`}
          />
        </Field>
        <button
          disabled={busy || !path.trim()}
          onClick={() => void run({ path: path.trim() }, path.trim())}
          className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-300 transition hover:bg-sky-500/20 disabled:opacity-50"
        >
          {busy ? 'Parsing…' : 'Parse script'}
        </button>

        <div className="flex items-center gap-3 text-[10px] uppercase tracking-wide text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          or upload
          <span className="h-px flex-1 bg-zinc-800" />
        </div>

        <div>
          <input
            type="file"
            accept=".ps1"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void f.text().then((content) => run({ content, fileName: f.name }, ''));
            }}
            className="block w-full text-[11px] text-zinc-400 file:mr-3 file:rounded-lg file:border file:border-zinc-700 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-[11px] file:text-zinc-300 hover:file:bg-zinc-800"
          />
          <p className="mt-1 text-[10px] text-zinc-600">
            An uploaded file can’t be re-synced later — use the path field if you want the
            “re-import” action.
          </p>
        </div>

        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>
      <div className="flex justify-end border-t border-zinc-800 px-5 py-3">
        <button
          onClick={onClose}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function StepsField({
  steps,
  onChange,
  label = 'Steps (run in order)',
  local = false,
  placeholder = 'npm run build',
}: {
  steps: DeployStep[];
  onChange: (s: DeployStep[]) => void;
  label?: string;
  /** local steps run on THIS machine — expose confirm + on/off controls */
  local?: boolean;
  placeholder?: string;
}) {
  function update(i: number, patch: Partial<DeployStep>) {
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  return (
    <div>
      <p className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-400">
        {label}
        {local && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-300">
            runs on this machine
          </span>
        )}
      </p>
      <div className="space-y-2">
        {steps.map((s, i) => (
          <div key={i} className="rounded-lg border border-zinc-800 p-2">
            <div className="mb-1 flex items-center gap-1">
              <span className="font-mono text-[10px] text-zinc-600">{i + 1}</span>
              <input
                value={s.name ?? ''}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="step name (optional)"
                className="flex-1 bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
              />
              {local && (
                <label
                  title="uncheck to keep the step but skip it"
                  className="flex items-center gap-1 text-[10px] text-zinc-500"
                >
                  <input
                    type="checkbox"
                    checked={s.enabled !== false}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                    className="accent-emerald-500"
                  />
                  on
                </label>
              )}
              <button onClick={() => move(i, -1)} className="px-1 text-zinc-600 hover:text-zinc-300">↑</button>
              <button onClick={() => move(i, 1)} className="px-1 text-zinc-600 hover:text-zinc-300">↓</button>
              <button
                onClick={() => onChange(steps.filter((_, j) => j !== i))}
                className="px-1 text-zinc-600 hover:text-rose-400"
              >
                ✕
              </button>
            </div>
            <textarea
              value={s.command}
              onChange={(e) => update(i, { command: e.target.value })}
              placeholder={placeholder}
              rows={s.command.split('\n').length > 2 ? s.command.split('\n').length : 2}
              className={`w-full resize-y rounded bg-zinc-950 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-zinc-700 ${
                local ? 'text-sky-300/90' : 'text-emerald-300/90'
              }`}
            />
            {local && (
              <input
                value={s.confirmBefore ?? ''}
                onChange={(e) => update(i, { confirmBefore: e.target.value || undefined })}
                placeholder="ask before running (leave blank to run without a prompt)"
                className="mt-1 w-full rounded bg-zinc-950/60 px-2 py-1 text-[11px] text-amber-200/90 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700"
              />
            )}
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...steps, { command: '' }])}
        className="mt-2 rounded-lg border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:bg-zinc-800"
      >
        + Add step
      </button>
    </div>
  );
}

function StringListField({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-400">{label}</p>
      <div className="space-y-1">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              value={v}
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
              placeholder={placeholder}
              className={`${inputCls} font-mono`}
            />
            <button
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              className="px-1 text-zinc-600 hover:text-rose-400"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...values, ''])}
        className="mt-1 rounded-lg border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:bg-zinc-800"
      >
        + Add
      </button>
    </div>
  );
}

// ── server manager ────────────────────────────────────────────────────────────

function ServerManager({
  servers,
  onClose,
  onChange,
}: {
  servers: ServerSummary[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<ServerSummary | 'new' | null>(null);

  if (editing) {
    return (
      <ServerForm
        initial={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await onChange();
        }}
        onChange={onChange}
      />
    );
  }

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-100">Servers</h3>
        <button
          onClick={() => setEditing('new')}
          className="rounded-lg bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-900 transition hover:bg-white"
        >
          + Add server
        </button>
      </div>
      <div className="max-h-[60vh] space-y-2 overflow-y-auto p-5">
        {servers.length === 0 && (
          <p className="text-center text-sm text-zinc-500">No servers yet.</p>
        )}
        {servers.map((s) => (
          <ServerRow key={s.id} server={s} onEdit={() => setEditing(s)} onChange={onChange} />
        ))}
      </div>
    </Modal>
  );
}

function ServerRow({
  server,
  onEdit,
  onChange,
}: {
  server: ServerSummary;
  onEdit: () => void;
  onChange: () => Promise<void>;
}) {
  const [test, setTest] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testServer(server.id));
    } catch (e) {
      setTest({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function del() {
    setDelError(null);
    try {
      await api.deleteServer(server.id);
      await onChange();
    } catch (e) {
      setDelError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-zinc-200">{server.name}</p>
          <p className="truncate font-mono text-xs text-zinc-500">
            {server.username}@{server.host}:{server.port}
          </p>
          {server.targetCount > 0 && (
            <p className="text-[11px] text-zinc-600">used by {server.targetCount} target(s)</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={runTest}
            disabled={testing}
            className="rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button
            onClick={onEdit}
            className="rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-800"
          >
            Edit
          </button>
          <button
            onClick={del}
            className="rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 transition hover:text-rose-300"
          >
            Delete
          </button>
        </div>
      </div>
      {test && (
        <p className={`mt-2 text-[11px] ${test.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
          {test.ok ? `✔ connected in ${test.latencyMs}ms` : `✖ ${test.error}`}
        </p>
      )}
      {delError && <p className="mt-2 text-[11px] text-rose-400">{delError}</p>}
    </div>
  );
}

function ServerForm({
  initial,
  onClose,
  onSaved,
  onChange,
}: {
  initial: ServerSummary | null;
  onClose: () => void;
  onSaved: () => void;
  onChange: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? 'ubuntu');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(initial?.id ?? null);
  const [test, setTest] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const keyFileRef = useRef<HTMLInputElement>(null);
  const [keyFileName, setKeyFileName] = useState<string | null>(null);
  const [keyFileError, setKeyFileError] = useState<string | null>(null);

  async function onKeyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setKeyFileError(null);
    setKeyFileName(null);
    if (file.size > 64_000) {
      setKeyFileError('That file is too large to be a private key (max 64 KB).');
      return;
    }
    const text = await file.text();
    // catch the classic mistake of picking the .pub / some random file
    if (!text.includes('PRIVATE KEY') && !text.includes('PuTTY-User-Key-File')) {
      setKeyFileError("That file doesn't look like a private key (.pem / OpenSSH / PuTTY).");
      return;
    }
    setPrivateKey(text.trim());
    setKeyFileName(file.name);
  }

  async function save(): Promise<string | null> {
    setError(null);
    if (!name.trim() || !host.trim() || !username.trim()) {
      setError('Name, host and username are required.');
      return null;
    }
    if (!initial && !privateKey.trim()) {
      setError('A PEM private key is required.');
      return null;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        privateKey: privateKey.trim() || undefined,
        passphrase: passphrase.trim() || undefined,
      };
      const saved = initial
        ? await api.updateServer(initial.id, body)
        : await api.createServer(body);
      await onChange();
      setSavedId(saved.id);
      setPrivateKey('');
      return saved.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndTest() {
    const id = savedId && !privateKey.trim() ? savedId : await save();
    if (!id) return;
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testServer(id));
    } catch (e) {
      setTest({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="border-b border-zinc-800 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-100">
          {initial ? `Edit ${initial.name}` : 'Add server'}
        </h3>
      </div>
      <div className="max-h-[65vh] space-y-3 overflow-y-auto px-5 py-4">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="staging-ec2" className={inputCls} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="Host">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="3.6.141.23" className={`${inputCls} font-mono`} />
            </Field>
          </div>
          <Field label="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
        </div>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} className={`${inputCls} font-mono`} />
        </Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">
              {initial ? 'PEM private key (leave blank to keep current)' : 'PEM private key'}
            </span>
            <button
              type="button"
              onClick={() => keyFileRef.current?.click()}
              className="rounded-lg border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:bg-zinc-800"
            >
              Upload key file…
            </button>
            {/* no `accept` filter — keys often have no extension (id_rsa) */}
            <input ref={keyFileRef} type="file" className="hidden" onChange={onKeyFile} />
          </div>
          <textarea
            value={privateKey}
            onChange={(e) => {
              setPrivateKey(e.target.value);
              setKeyFileName(null); // manual edits invalidate the "loaded from" note
            }}
            placeholder={'-----BEGIN RSA PRIVATE KEY-----\n… paste, or use "Upload key file"'}
            rows={6}
            className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
          />
          {keyFileName && (
            <p className="mt-1 text-[11px] text-emerald-400">✔ loaded from {keyFileName}</p>
          )}
          {keyFileError && <p className="mt-1 text-[11px] text-rose-400">{keyFileError}</p>}
        </div>
        <Field label="Key passphrase (optional)">
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className={inputCls}
          />
        </Field>
        <p className="text-[11px] text-zinc-600">
          The key is encrypted at rest and never leaves this machine or appears in logs.
        </p>
        {test && (
          <p className={`text-[11px] ${test.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
            {test.ok ? `✔ connected in ${test.latencyMs}ms` : `✖ ${test.error}`}
          </p>
        )}
        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>
      <div className="flex justify-between gap-2 border-t border-zinc-800 px-5 py-3">
        <button
          onClick={saveAndTest}
          disabled={saving || testing}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
        >
          {testing ? 'Testing…' : 'Save & test connection'}
        </button>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
          >
            Close
          </button>
          <button
            onClick={async () => {
              const id = await save();
              if (id) onSaved();
            }}
            disabled={saving}
            className="rounded-lg bg-zinc-100 px-4 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── primitives ────────────────────────────────────────────────────────────────

const inputCls =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function splitCsv(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function Modal({
  children,
  onClose,
  wide,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={`flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl ${
          wide ? 'max-w-2xl' : 'max-w-lg'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function RocketGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-10 w-10 text-zinc-700">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}
