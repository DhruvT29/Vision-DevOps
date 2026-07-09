'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { EnvironmentSummary, GraphPayload, ScanStatus } from '@vision/shared';
import { api } from '@/lib/api';
import { layoutGraph } from '@/lib/layout';
import { nodeTypes } from '@/components/graph-nodes';
import { EndpointPanel } from '@/components/EndpointPanel';
import { EnvPicker } from '@/components/EnvPicker';
import { Sidebar } from '@/components/Sidebar';

export function GraphView({ snapshotId }: { snapshotId: string }) {
  const [status, setStatus] = useState<ScanStatus>('pending');
  const [scanError, setScanError] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [envs, setEnvs] = useState<EnvironmentSummary[]>([]);
  const [envId, setEnvId] = useState('');
  const [showSidebar, setShowSidebar] = useState(false);

  const projectId = graph?.snapshot.projectId;

  const loadEnvs = useCallback(async () => {
    if (!projectId) return;
    const list = await api.listEnvironments(projectId).catch(() => []);
    setEnvs(list);
    setEnvId((prev) => prev || (list[0]?.id ?? ''));
  }, [projectId]);

  useEffect(() => {
    loadEnvs();
  }, [loadEnvs]);

  // Poll until the scan completes, then fetch the graph once.
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
          if (!cancelled) setGraph(payload);
        } else if (snap.status === 'failed') {
          setScanError(snap.error ?? 'Scan failed');
        } else {
          timer = setTimeout(poll, 800);
        }
      } catch (e) {
        if (!cancelled) setScanError(e instanceof Error ? e.message : String(e));
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [snapshotId]);

  const moduleById = useMemo(
    () => new Map(graph?.modules.map((m) => [m.id, m]) ?? []),
    [graph],
  );
  const endpointById = useMemo(
    () => new Map(graph?.endpoints.map((e) => [e.id, e]) ?? []),
    [graph],
  );

  const matchesSearch = useCallback(
    (text: string) => search === '' || text.toLowerCase().includes(search.toLowerCase()),
    [search],
  );

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };

    const nodes: Node[] = [];
    const edges: Edge[] = [];

    for (const mod of graph.modules) {
      const modEndpoints = graph.endpoints.filter((e) => e.moduleId === mod.id);
      const modVisible =
        matchesSearch(mod.name) || modEndpoints.some((e) => matchesSearch(e.fullPath));
      if (!modVisible) continue;

      const isExpanded = expanded.has(mod.id);
      nodes.push({
        id: mod.id,
        type: 'module',
        position: { x: 0, y: 0 },
        data: { module: mod, expanded: isExpanded },
      });

      if (!isExpanded) continue;
      for (const ep of modEndpoints) {
        if (!matchesSearch(ep.fullPath) && !matchesSearch(mod.name)) continue;
        nodes.push({
          id: ep.id,
          type: 'endpoint',
          position: { x: 0, y: 0 },
          data: { endpoint: ep, selected: ep.id === selectedId },
        });
        edges.push({
          id: `${mod.id}->${ep.id}`,
          source: mod.id,
          target: ep.id,
          style: { stroke: '#3f3f46' },
        });
      }
    }

    return { nodes: layoutGraph(nodes, edges), edges };
  }, [graph, expanded, selectedId, matchesSearch]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (node.type === 'module') {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
    } else if (node.type === 'endpoint') {
      setSelectedId((prev) => (prev === node.id ? null : node.id));
    }
  }, []);

  const selectedEndpoint = selectedId ? endpointById.get(selectedId) : undefined;

  if (scanError) {
    return (
      <Shell>
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-red-400">Scan failed</p>
          <p className="max-w-lg text-center font-mono text-xs text-zinc-500">{scanError}</p>
          <Link href="/" className="text-sm text-sky-400 hover:underline">← back</Link>
        </div>
      </Shell>
    );
  }

  if (!graph) {
    return (
      <Shell>
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200" />
          <p className="text-sm text-zinc-400">
            {status === 'running' ? 'Analyzing project…' : 'Starting scan…'}
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      toolbar={
        <>
          <button
            onClick={() => setShowSidebar((s) => !s)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
              showSidebar
                ? 'border-sky-500/50 bg-sky-950/50 text-sky-300'
                : 'border-zinc-800 text-zinc-300 hover:border-zinc-600'
            }`}
          >
            Collections
          </button>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter modules & endpoints…"
            spellCheck={false}
            className="w-64 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          <span className="text-xs text-zinc-500">
            {graph.snapshot.stats?.modules} modules · {graph.snapshot.stats?.endpoints} endpoints
          </span>
          <button
            onClick={() =>
              setExpanded((prev) =>
                prev.size === graph.modules.length
                  ? new Set()
                  : new Set(graph.modules.map((m) => m.id)),
              )
            }
            className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600"
          >
            {expanded.size === graph.modules.length ? 'Collapse all' : 'Expand all'}
          </button>
          <div className="ml-auto">
            {projectId && (
              <EnvPicker
                envs={envs}
                envId={envId}
                onSelect={setEnvId}
                projectId={projectId}
                onCreated={loadEnvs}
              />
            )}
          </div>
        </>
      }
    >
      {showSidebar && projectId && <Sidebar projectId={projectId} envId={envId} />}
      <div className="relative min-h-0 min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.05}
          proOptions={{ hideAttribution: true }}
          className="!bg-zinc-950"
        >
          <Background color="#27272a" gap={24} />
          <Controls className="!border-zinc-800 !bg-zinc-900 [&_button]:!border-zinc-800 [&_button]:!bg-zinc-900 [&_button]:!text-zinc-300" />
          <MiniMap
            className="!border !border-zinc-800 !bg-zinc-900"
            nodeColor={(n) => (n.type === 'module' ? '#0ea5e9' : '#3f3f46')}
            maskColor="rgba(9,9,11,0.7)"
          />
        </ReactFlow>
      </div>
      {selectedEndpoint && (
        <EndpointPanel
          endpoint={selectedEndpoint}
          module={moduleById.get(selectedEndpoint.moduleId)}
          projectId={graph.snapshot.projectId}
          envs={envs}
          envId={envId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </Shell>
  );
}

function Shell({
  children,
  toolbar,
}: {
  children: React.ReactNode;
  toolbar?: React.ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2.5">
        <Link href="/" className="text-sm font-bold tracking-tight text-zinc-100 hover:text-white">
          Vision
        </Link>
        {toolbar}
      </header>
      <div className="relative flex min-h-0 flex-1">{children}</div>
    </div>
  );
}
