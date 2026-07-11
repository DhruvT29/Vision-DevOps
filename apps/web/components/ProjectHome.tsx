'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ProjectSummary, SnapshotSummary } from '@vision/shared';
import { api } from '@/lib/api';
import { AppShell } from '@/components/AppShell';

export function ProjectHome({ snapshotId }: { snapshotId: string }) {
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);

  // Poll while the scan is still running so the navbar stats fill in.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const snap = await api.snapshot(snapshotId);
        if (cancelled) return;
        setSnapshot(snap);
        if (snap.status === 'pending' || snap.status === 'running') {
          timer = setTimeout(poll, 1000);
        }
      } catch {
        // engine offline — leave the shell empty
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [snapshotId]);

  const projectId = snapshot?.projectId;
  useEffect(() => {
    if (!projectId) return;
    api
      .listProjects()
      .then((list) => setProject(list.find((p) => p.id === projectId) ?? null))
      .catch(() => {});
  }, [projectId]);

  return (
    <AppShell snapshotId={snapshotId} stats={snapshot?.stats}>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <h1 className="text-4xl font-bold tracking-tight">{project?.name ?? '…'}</h1>
        {project && (
          <p className="font-mono text-sm text-zinc-500">
            {project.source === 'github' ? project.repoUrl ?? project.rootPath : project.rootPath}
            {project.source === 'github' && project.repoBranch && ` · ${project.repoBranch}`}
          </p>
        )}
        {snapshot && snapshot.status !== 'completed' && (
          <p className="text-sm text-zinc-400">
            {snapshot.status === 'failed'
              ? `Scan failed${snapshot.error ? `: ${snapshot.error}` : ''}`
              : 'Analyzing project…'}
          </p>
        )}
        <Link
          href={`/graph/${snapshotId}`}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition hover:border-zinc-500 hover:text-white"
        >
          Open Endpoint Graph →
        </Link>
      </div>
    </AppShell>
  );
}
