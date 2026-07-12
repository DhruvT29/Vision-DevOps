'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  ChangedFile,
  CouplingMeta,
  DiffImpactResult,
  FrontendCall,
  GraphEdge,
  GraphPayload,
  ModuleNode as ModuleNodeData,
  ScanStatus,
} from '@vision/shared';
import { api } from '@/lib/api';
import { layoutDependencyGraph } from '@/lib/dependency-layout';
import { methodBadge } from '@/lib/method-colors';
import { AppShell } from '@/components/AppShell';

const ONE_WAY = '#0ea5e9'; // sky-500 — unidirectional dependency
const TWO_WAY = '#f59e0b'; // amber-500 — mutual (circular) dependency
const HUE_COLOR = { rose: '#f43f5e', emerald: '#10b981' } as const;

type Mode = 'neighbors' | 'impact';
type Direction = 'upstream' | 'downstream';
type ImpactTier = 'direct' | 'indirect' | 'global';
type ImpactLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';
type Hue = 'rose' | 'emerald';

type DepFlowNode = Node<
  {
    module: ModuleNodeData;
    selected: boolean;
    dimmed: boolean;
    impact?: ImpactTier;
    hue: Hue;
  },
  'module'
>;

export const IMPACT_NODE_STYLE: Record<Hue, Record<ImpactTier, string>> = {
  rose: {
    direct: 'border-rose-500/70 bg-rose-950/45 shadow-lg shadow-rose-500/10',
    indirect: 'border-rose-500/35 bg-rose-950/25',
    global: 'border-dashed border-rose-400/40 bg-rose-950/15',
  },
  emerald: {
    direct: 'border-emerald-500/70 bg-emerald-950/45 shadow-lg shadow-emerald-500/10',
    indirect: 'border-emerald-500/35 bg-emerald-950/25',
    global: 'border-dashed border-emerald-400/40 bg-emerald-950/15',
  },
};

const LEVEL_STYLE: Record<ImpactLevel, string> = {
  critical: 'border-rose-500/40 bg-rose-950/70 text-rose-300',
  high: 'border-orange-500/40 bg-orange-950/70 text-orange-300',
  medium: 'border-amber-500/40 bg-amber-950/70 text-amber-300',
  low: 'border-emerald-500/40 bg-emerald-950/70 text-emerald-300',
  none: 'border-zinc-700 bg-zinc-900 text-zinc-500',
};

/** Module card — selectable, dims when unrelated, impact-graded when analyzing. */
export function DependencyModuleNode({ data }: NodeProps<DepFlowNode>) {
  const { module: mod, selected, dimmed, impact, hue } = data;
  const border = selected
    ? 'border-sky-500/60 bg-sky-950/60 shadow-lg shadow-sky-500/10'
    : impact
      ? IMPACT_NODE_STYLE[hue][impact]
      : 'border-[rgba(144,161,255,0.17)] bg-[rgba(65,65,65,0.11)] hover:border-sky-400/60 hover:shadow-[0_0_40px_-6px_rgba(14,165,233,0.5)]';
  return (
    <div
      className={`flex h-16 w-60 cursor-pointer items-center justify-between rounded-xl border px-4 backdrop-blur-xl transition ${border} ${
        dimmed ? 'opacity-20' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-zinc-100">
          {mod.name.replace(/Module$/, '')}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-sky-500/80">{mod.kind}</span>
          {mod.isGlobal && (
            <span
              className="rounded bg-violet-950/80 px-1 py-px text-[9px] font-semibold tracking-wide text-violet-300"
              title="@Global() — providers usable everywhere without imports"
            >
              GLOBAL
            </span>
          )}
        </div>
      </div>
      <span
        className="ml-2 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300"
        title={`${mod.endpointCount} endpoints`}
      >
        {mod.endpointCount}
      </span>
      {/* invisible — edges float freely along the card border instead */}
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const depNodeTypes = { module: DependencyModuleNode };

function centerOf(node: InternalNode) {
  const w = node.measured?.width ?? 240;
  const h = node.measured?.height ?? 64;
  return {
    x: node.internals.positionAbsolute.x + w / 2,
    y: node.internals.positionAbsolute.y + h / 2,
    w,
    h,
  };
}

/** Point where the ray from a card's center toward (tx,ty) crosses its border. */
function borderPoint(c: { x: number; y: number; w: number; h: number }, tx: number, ty: number) {
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: c.y };
  const sx = dx !== 0 ? c.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? c.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

function sideOf(from: { x: number; y: number }, to: { x: number; y: number }): Position {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? Position.Right : Position.Left;
  return dy > 0 ? Position.Bottom : Position.Top;
}

/**
 * Edge that attaches wherever the cards face each other (rather than fixed
 * left/right handles), so lines fan out instead of bundling into one point.
 * Mutual pairs get a perpendicular `data.offset` so the two arrows run side
 * by side in opposite directions.
 */
export function FloatingDependencyEdge({ id, source, target, style, markerEnd, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  const sc = centerOf(sourceNode);
  const tc = centerOf(targetNode);

  const offset = (data?.offset as number | undefined) ?? 0;
  if (offset) {
    const dx = tc.x - sc.x;
    const dy = tc.y - sc.y;
    const len = Math.hypot(dx, dy) || 1;
    const ox = (-dy / len) * offset;
    const oy = (dx / len) * offset;
    sc.x += ox;
    sc.y += oy;
    tc.x += ox;
    tc.y += oy;
  }

  const s = borderPoint(sc, tc.x, tc.y);
  const t = borderPoint(tc, sc.x, sc.y);

  const [path] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: sideOf(sc, tc),
    targetX: t.x,
    targetY: t.y,
    targetPosition: sideOf(tc, sc),
    curvature: 0.18,
  });
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

const depEdgeTypes = { floating: FloatingDependencyEdge };

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; title?: string }[];
}) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          title={o.title}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
            value === o.value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LevelBadge({ level }: { level: ImpactLevel }) {
  return (
    <span
      className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${LEVEL_STYLE[level]}`}
      title="Severity from direct dependents + share of modules affected (CodeFlow-style weighting)"
    >
      {level}
    </span>
  );
}

// ── Impact math ───────────────────────────────────────────────────────────────

export interface ImpactResult {
  roots: Set<string>;
  /** moduleId → BFS distance from the nearest root (≥1) */
  distance: Map<string, number>;
  /** modules reachable only through @Global() semantics (no explicit edge) */
  globalReach: Set<string>;
  direct: number;
  total: number;
  /** share of non-root modules affected, 0..1 */
  pct: number;
  /** weighted: direct count fully, transitive decay by distance */
  score: number;
  /** in+out degree of the roots */
  centrality: number;
  level: ImpactLevel;
}

export function computeImpact(
  rootIds: string[],
  direction: Direction,
  graph: GraphPayload,
  forward: Map<string, Set<string>>,
  reverse: Map<string, Set<string>>,
  moduleById: Map<string, ModuleNodeData>,
): ImpactResult {
  const roots = new Set(rootIds);
  const adj = direction === 'upstream' ? reverse : forward;
  const distance = new Map<string, number>();
  const visited = new Set(roots);
  let frontier = [...roots];
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        distance.set(nb, d);
        next.push(nb);
      }
    }
    frontier = next;
  }

  const globalReach = new Set<string>();
  if (direction === 'upstream' && rootIds.some((id) => moduleById.get(id)?.isGlobal)) {
    for (const m of graph.modules) if (!visited.has(m.id)) globalReach.add(m.id);
  }
  if (direction === 'downstream') {
    for (const m of graph.modules) if (m.isGlobal && !visited.has(m.id)) globalReach.add(m.id);
  }

  const direct = [...distance.values()].filter((x) => x === 1).length;
  const total = distance.size + globalReach.size;
  const others = Math.max(1, graph.modules.length - roots.size);
  const pct = total / others;

  // CodeFlow's calcBlast weighting adapted to modules: direct dependents count
  // fully, transitive decay by 1/distance, global reach at a light weight.
  let score = direct + globalReach.size * 0.25;
  distance.forEach((dist) => {
    if (dist > 1) score += 1 / dist;
  });
  let centrality = 0;
  for (const id of roots) {
    centrality += (forward.get(id)?.size ?? 0) + (reverse.get(id)?.size ?? 0);
  }

  const level: ImpactLevel =
    total === 0
      ? 'none'
      : direct >= 6 || pct >= 0.6
        ? 'critical'
        : direct >= 4 || pct >= 0.35
          ? 'high'
          : direct >= 2 || pct >= 0.15
            ? 'medium'
            : 'low';

  return {
    roots,
    distance,
    globalReach,
    direct,
    total,
    pct,
    score: Math.round(score * 10) / 10,
    centrality,
    level,
  };
}

/** Frontend call sites whose linked endpoint lives in an affected module. */
export function callSitesAtRisk(graph: GraphPayload, affected: Set<string>): FrontendCall[] {
  const endpointModule = new Map(graph.endpoints.map((e) => [e.id, e.moduleId]));
  const callIds = new Set<string>();
  for (const e of graph.edges) {
    if (e.type !== 'calls') continue;
    const m = endpointModule.get(e.targetId);
    if (m && affected.has(m)) callIds.add(e.sourceId);
  }
  return graph.frontendCalls
    .filter((c) => callIds.has(c.id))
    .sort((a, b) => (a.resolvedPath ?? a.rawUrl).localeCompare(b.resolvedPath ?? b.rawUrl));
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function DependencyView({ snapshotId }: { snapshotId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<ScanStatus>('pending');
  const [scanError, setScanError] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<Mode>('impact');
  const [direction, setDirection] = useState<Direction>('upstream');
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffImpactResult | null>(null);

  // Re-open the project (over its original source) → new snapshot → navigate.
  const rescan = useCallback(async () => {
    if (!graph || rescanning) return;
    setRescanning(true);
    setRescanError(null);
    try {
      const projects = await api.listProjects();
      const project = projects.find((p) => p.id === graph.snapshot.projectId);
      if (!project) throw new Error('Project not found');
      const res =
        project.source === 'github'
          ? await api.openGithub({
              repoUrl: project.repoCloneUrl ?? project.repoUrl ?? '',
              branch: project.repoBranch,
            })
          : await api.openProject(project.rootPath);
      router.push(`/dependencies/${res.snapshot.id}`);
    } catch (e) {
      setRescanError(e instanceof Error ? e.message : String(e));
      setRescanning(false);
    }
  }, [graph, rescanning, router]);

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

  // union of declared wiring + hidden file-level coupling
  const depEdges = useMemo(
    () => graph?.edges.filter((e) => e.type === 'imports' || e.type === 'file-imports') ?? [],
    [graph],
  );
  const declaredCount = useMemo(
    () => depEdges.filter((e) => e.type === 'imports').length,
    [depEdges],
  );
  const edgeKeys = useMemo(
    () => new Set(depEdges.map((e) => `${e.sourceId}->${e.targetId}`)),
    [depEdges],
  );
  const { forward, reverse } = useMemo(() => {
    const forward = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, a: string, b: string) => {
      let set = map.get(a);
      if (!set) map.set(a, (set = new Set()));
      set.add(b);
    };
    for (const e of depEdges) {
      add(forward, e.sourceId, e.targetId);
      add(reverse, e.targetId, e.sourceId);
    }
    return { forward, reverse };
  }, [depEdges]);
  const mutualPairCount = useMemo(() => {
    let n = 0;
    for (const e of depEdges) {
      if (edgeKeys.has(`${e.targetId}->${e.sourceId}`)) n++;
    }
    return n / 2;
  }, [depEdges, edgeKeys]);

  const moduleById = useMemo(
    () => new Map(graph?.modules.map((m) => [m.id, m]) ?? []),
    [graph],
  );

  // diff mode forces impact/upstream — "what does my change break"
  const effDirection: Direction = diff ? 'upstream' : direction;
  const hue: Hue = effDirection === 'upstream' ? 'rose' : 'emerald';

  const rootIds = useMemo<string[] | null>(() => {
    if (diff) {
      const ids = diff.moduleIds.filter((id) => moduleById.has(id));
      return ids.length > 0 ? ids : null;
    }
    if (mode === 'impact' && selectedId) return [selectedId];
    return null;
  }, [diff, mode, selectedId, moduleById]);

  const impact = useMemo<ImpactResult | null>(() => {
    if (!graph || !rootIds) return null;
    return computeImpact(rootIds, effDirection, graph, forward, reverse, moduleById);
  }, [graph, rootIds, effDirection, forward, reverse, moduleById]);

  // one-hop neighborhood for the quick-orientation mode
  const neighborsOf = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let set = map.get(a);
      if (!set) map.set(a, (set = new Set()));
      set.add(b);
    };
    for (const e of depEdges) {
      add(e.sourceId, e.targetId);
      add(e.targetId, e.sourceId);
    }
    return map;
  }, [depEdges]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };

    const q = search.toLowerCase();
    const visibleModules = graph.modules.filter(
      (m) => q === '' || m.name.toLowerCase().includes(q),
    );
    const visibleIds = new Set(visibleModules.map((m) => m.id));
    const neighbors = selectedId ? neighborsOf.get(selectedId) : undefined;
    const highlightActive = !!impact || (!!selectedId && mode === 'neighbors');
    const impactedIds = impact
      ? new Set([...impact.roots, ...impact.distance.keys(), ...impact.globalReach])
      : null;

    const nodes: Node[] = visibleModules.map((m) => {
      const isRoot = impact ? impact.roots.has(m.id) : m.id === selectedId;
      let tier: ImpactTier | undefined;
      let dimmed = false;
      if (highlightActive && !isRoot) {
        if (impact) {
          const d = impact.distance.get(m.id);
          tier =
            d === 1 ? 'direct' : d ? 'indirect' : impact.globalReach.has(m.id) ? 'global' : undefined;
          dimmed = !tier;
        } else {
          dimmed = !neighbors?.has(m.id);
        }
      }
      return {
        id: m.id,
        type: 'module',
        position: { x: 0, y: 0 },
        data: { module: m, selected: isRoot, dimmed, impact: tier, hue },
      };
    });

    const edges: Edge[] = depEdges
      .filter((e) => visibleIds.has(e.sourceId) && visibleIds.has(e.targetId))
      .map((e) => {
        // mutual pairs keep two separate arrows, drawn in amber
        const mutual = edgeKeys.has(`${e.targetId}->${e.sourceId}`);
        const onImpactPath =
          !!impactedIds && impactedIds.has(e.sourceId) && impactedIds.has(e.targetId);
        const incident =
          !!selectedId &&
          mode === 'neighbors' &&
          !impact &&
          (e.sourceId === selectedId || e.targetId === selectedId);
        const highlighted = onImpactPath || incident;
        const dim = highlightActive && !highlighted;
        const color = onImpactPath ? HUE_COLOR[hue] : mutual ? TWO_WAY : ONE_WAY;
        return {
          id: e.id,
          source: e.sourceId,
          target: e.targetId,
          type: 'floating' as const,
          animated: highlighted,
          data: { offset: mutual ? 11 : 0 },
          style: {
            stroke: color,
            strokeWidth: highlighted ? 2 : 1.5,
            strokeDasharray: e.type === 'file-imports' ? '6 4' : undefined,
            opacity: dim ? 0.06 : 0.7,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
        };
      });

    return { nodes: layoutDependencyGraph(nodes, edges), edges };
  }, [graph, depEdges, edgeKeys, neighborsOf, impact, hue, mode, search, selectedId]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setDiff(null); // node click exits diff mode into normal selection
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  }, []);

  const selectedModule = selectedId ? moduleById.get(selectedId) : undefined;

  if (scanError) {
    return (
      <AppShell snapshotId={snapshotId}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="text-red-400">Scan failed</p>
          <p className="max-w-lg text-center font-mono text-xs text-zinc-500">{scanError}</p>
          <Link href="/" className="text-sm text-sky-400 hover:underline">← back</Link>
        </div>
      </AppShell>
    );
  }

  if (!graph) {
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

  return (
    <AppShell snapshotId={snapshotId} stats={graph.snapshot.stats}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter modules…"
            spellCheck={false}
            className="w-44 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              setDiff(null);
            }}
            options={[
              {
                value: 'impact',
                label: 'Impact',
                title: 'Click a module to see its full transitive blast radius',
              },
              {
                value: 'neighbors',
                label: 'Neighbors',
                title: 'Click a module to highlight only its direct connections',
              },
            ]}
          />
          {mode === 'impact' && !diff && (
            <Segmented
              value={direction}
              onChange={setDirection}
              options={[
                {
                  value: 'upstream',
                  label: 'Affected by it',
                  title: 'What breaks if I change this module — everything that depends on it',
                },
                {
                  value: 'downstream',
                  label: 'It depends on',
                  title: 'Everything this module relies on, directly or transitively',
                },
              ]}
            />
          )}
          <DiffControl snapshotId={snapshotId} diff={diff} onResult={setDiff} onClear={() => setDiff(null)} />
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 xl:flex" title="Declared NestJS wiring: @Module({ imports })">
            <span className="inline-block h-0.5 w-5 rounded bg-sky-500/80" />
            declared
          </span>
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 xl:flex" title="Raw imports between module folders that bypass the @Module wiring">
            <svg width="20" height="2" className="shrink-0">
              <line x1="0" y1="1" x2="20" y2="1" stroke="#0ea5e9" strokeWidth="2" strokeDasharray="4 3" opacity="0.8" />
            </svg>
            file-level
          </span>
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 xl:flex" title="Two modules that import each other">
            <span className="inline-block h-0.5 w-5 rounded bg-amber-500/80" />
            circular
          </span>
          <span className="ml-auto flex items-center gap-3">
            {rescanError && <span className="text-xs text-red-400">{rescanError}</span>}
            <button
              onClick={rescan}
              disabled={rescanning}
              title="Re-analyze the project and rebuild this graph"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 disabled:cursor-default disabled:opacity-50"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`h-3.5 w-3.5 ${rescanning ? 'animate-spin' : ''}`}
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
              {rescanning ? 'Rescanning…' : 'Rescan'}
            </button>
            <span className="whitespace-nowrap text-xs text-zinc-500">
              {graph.modules.length} modules · {declaredCount} declared ·{' '}
              {depEdges.length - declaredCount} file-level
              {mutualPairCount > 0 && ` · ${mutualPairCount} circular`}
            </span>
          </span>
        </div>
        {depEdges.length === 0 && (
          <div className="border-b border-amber-900/40 bg-amber-950/20 px-4 py-2 text-xs text-amber-300/90">
            No module dependencies in this snapshot — it was likely scanned before the Dependency
            Graph existed. Hit <span className="font-semibold">Rescan</span> (top right) to
            re-analyze the project.
          </div>
        )}
        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={depNodeTypes}
              edgeTypes={depEdgeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={() => {
                setSelectedId(null);
                setDiff(null);
              }}
              fitView
              minZoom={0.05}
              proOptions={{ hideAttribution: true }}
              className="!bg-zinc-950"
            >
              <Background color="#27272a" gap={24} />
              <Controls className="!border-zinc-800 !bg-zinc-900 [&_button]:!border-zinc-800 [&_button]:!bg-zinc-900 [&_button]:!text-zinc-300" />
              <MiniMap
                className="!border !border-zinc-800 !bg-zinc-900"
                nodeColor={(n) =>
                  (n.data as { selected?: boolean })?.selected ? '#0ea5e9' : '#3f3f46'
                }
                maskColor="rgba(9,9,11,0.7)"
              />
            </ReactFlow>
          </div>
          {diff && impact ? (
            <DiffPanel
              diff={diff}
              impact={impact}
              graph={graph}
              moduleById={moduleById}
              onSelect={(id) => {
                setDiff(null);
                setSelectedId(id);
              }}
              onClose={() => setDiff(null)}
            />
          ) : (
            selectedModule && (
              <DependencyPanel
                module={selectedModule}
                graph={graph}
                depEdges={depEdges}
                edgeKeys={edgeKeys}
                moduleById={moduleById}
                mode={mode}
                direction={direction}
                impact={impact}
                onSelect={setSelectedId}
                onClose={() => setSelectedId(null)}
              />
            )
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── Diff impact control (toolbar) ─────────────────────────────────────────────

function DiffControl({
  snapshotId,
  diff,
  onResult,
  onClear,
}: {
  snapshotId: string;
  diff: DiffImpactResult | null;
  onResult: (r: DiffImpactResult) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as globalThis.Node)) setOpen(false);
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

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.diffImpact(snapshotId, base.trim() || undefined);
      if (result.changedFiles.length === 0) {
        setError('No changes found against that ref');
      } else {
        onResult(result);
        setOpen(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (diff) {
    const owned = diff.changedFiles.filter((f) => f.moduleId).length;
    return (
      <span className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-950/30 px-2.5 py-1 text-xs text-rose-200">
        <GitDiffIcon />
        diff vs <span className="font-mono">{diff.base}</span>: {diff.changedFiles.length} files ·{' '}
        {diff.moduleIds.length} modules{owned < diff.changedFiles.length && ' (+outside)'}
        <button
          onClick={onClear}
          aria-label="Clear diff impact"
          className="ml-1 rounded p-0.5 text-rose-300 transition hover:bg-rose-900/60 hover:text-rose-100"
        >
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Blast radius of your actual changes — maps a git diff to modules"
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
          open
            ? 'border-rose-500/50 bg-rose-950/40 text-rose-200'
            : 'border-zinc-800 text-zinc-300 hover:border-zinc-600'
        }`}
      >
        <GitDiffIcon />
        Diff impact
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-xl shadow-black/50">
          <p className="text-xs font-semibold text-zinc-200">Impact of a real change</p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Diffs the working tree against a git ref, maps changed files to their modules, and
            shows the combined blast radius.
          </p>
          <input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run();
            }}
            placeholder="base ref — empty = HEAD (uncommitted)"
            spellCheck={false}
            className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
          <button
            onClick={run}
            disabled={busy}
            className="mt-2 w-full rounded-md border border-rose-500/40 bg-rose-950/40 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-950/70 disabled:opacity-50"
          >
            {busy ? 'Analyzing…' : 'Analyze diff'}
          </button>
        </div>
      )}
    </div>
  );
}

function GitDiffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V15a3 3 0 0 0 3 3h6.5M18 15.5V9a3 3 0 0 0-3-3H8.5" />
    </svg>
  );
}

// ── Panels ────────────────────────────────────────────────────────────────────

export function ImpactSummaryCard({
  impact,
  direction,
  isGlobalRoot,
  label,
}: {
  impact: ImpactResult;
  direction: Direction;
  isGlobalRoot: boolean;
  label: string;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        direction === 'upstream'
          ? 'border-rose-900/50 bg-rose-950/20'
          : 'border-emerald-900/50 bg-emerald-950/20'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-zinc-200">{label}</p>
        {direction === 'upstream' && <LevelBadge level={impact.level} />}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-base font-semibold text-zinc-100">{impact.direct}</div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">direct</div>
        </div>
        <div>
          <div className="text-base font-semibold text-zinc-100">{impact.total}</div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">total</div>
        </div>
        <div>
          <div className="text-base font-semibold text-zinc-100">{Math.round(impact.pct * 100)}%</div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">of modules</div>
        </div>
        <div>
          <div className="text-base font-semibold text-zinc-100" title="Direct dependents count fully; transitive decay by 1/distance">
            {impact.score}
          </div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">score</div>
        </div>
      </div>
      {isGlobalRoot && direction === 'upstream' && (
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
          Includes <span className="text-violet-300">@Global()</span> reach — providers usable
          anywhere, so every module is potentially affected.
        </p>
      )}
    </div>
  );
}

function DependencyPanel({
  module: mod,
  graph,
  depEdges,
  edgeKeys,
  moduleById,
  mode,
  direction,
  impact,
  onSelect,
  onClose,
}: {
  module: ModuleNodeData;
  graph: GraphPayload;
  depEdges: GraphEdge[];
  edgeKeys: Set<string>;
  moduleById: Map<string, ModuleNodeData>;
  mode: Mode;
  direction: Direction;
  impact: ImpactResult | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const isMutual = (otherId: string) =>
    edgeKeys.has(`${mod.id}->${otherId}`) && edgeKeys.has(`${otherId}->${mod.id}`);

  const relationItems = (edges: GraphEdge[], other: (e: GraphEdge) => string) =>
    edges
      .flatMap((e) => {
        const m = moduleById.get(other(e));
        // dep edges only ever carry CouplingMeta (touch/fk meta lives on other edge types)
        return m
          ? [{ module: m, meta: e.meta as CouplingMeta | undefined, fileLevel: e.type === 'file-imports' }]
          : [];
      })
      .sort((a, b) => a.module.name.localeCompare(b.module.name));

  const imports = relationItems(
    depEdges.filter((e) => e.sourceId === mod.id),
    (e) => e.targetId,
  );
  const importedBy = relationItems(
    depEdges.filter((e) => e.targetId === mod.id),
    (e) => e.sourceId,
  );

  // impact groups, ordered by distance then name
  const impactGroups = useMemo(() => {
    if (!impact) return null;
    const rows = [...impact.distance.entries()]
      .flatMap(([id, d]) => {
        const m = moduleById.get(id);
        return m ? [{ module: m, distance: d as number | undefined }] : [];
      })
      .sort(
        (a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.module.name.localeCompare(b.module.name),
      );
    return {
      direct: rows.filter((r) => r.distance === 1),
      indirect: rows.filter((r) => (r.distance ?? 0) > 1),
      global: [...impact.globalReach]
        .flatMap((id) => {
          const m = moduleById.get(id);
          return m ? [m] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [impact, moduleById]);

  const callsAtRisk = useMemo(() => {
    if (!impact || direction !== 'upstream') return null;
    return callSitesAtRisk(
      graph,
      new Set([mod.id, ...impact.distance.keys(), ...impact.globalReach]),
    );
  }, [impact, direction, mod.id, graph]);

  const hue: Hue = direction === 'upstream' ? 'rose' : 'emerald';

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[360px] flex-col gap-5 overflow-y-auto border-l border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="break-all text-sm font-semibold text-zinc-100">{mod.name}</h2>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-sky-500/80">{mod.kind}</span>
            {mod.isGlobal && (
              <span
                className="rounded bg-violet-950/80 px-1 py-px text-[9px] font-semibold tracking-wide text-violet-300"
                title="@Global() — providers usable everywhere without imports"
              >
                GLOBAL
              </span>
            )}
          </div>
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

      {mode === 'impact' && impact && impactGroups && (
        <>
          <ImpactSummaryCard
            impact={impact}
            direction={direction}
            isGlobalRoot={!!mod.isGlobal}
            label={direction === 'upstream' ? 'Blast radius if changed' : 'What it relies on'}
          />

          <ImpactList
            title={
              direction === 'upstream'
                ? `Directly affected (${impactGroups.direct.length})`
                : `Uses directly (${impactGroups.direct.length})`
            }
            rows={impactGroups.direct}
            hue={hue}
            isMutual={isMutual}
            onSelect={onSelect}
            emptyText={
              direction === 'upstream' ? 'No module imports this one' : 'No project-module dependencies'
            }
          />
          {impactGroups.indirect.length > 0 && (
            <ImpactList
              title={
                direction === 'upstream'
                  ? `Indirectly affected (${impactGroups.indirect.length})`
                  : `Uses transitively (${impactGroups.indirect.length})`
              }
              rows={impactGroups.indirect}
              hue={hue}
              isMutual={isMutual}
              onSelect={onSelect}
              emptyText=""
            />
          )}
          {impactGroups.global.length > 0 && (
            <ImpactList
              title={
                direction === 'upstream'
                  ? `Global reach (${impactGroups.global.length})`
                  : `Global modules, implicitly available (${impactGroups.global.length})`
              }
              rows={impactGroups.global.map((m) => ({ module: m, distance: undefined }))}
              hue={hue}
              isMutual={isMutual}
              onSelect={onSelect}
              emptyText=""
            />
          )}

          {callsAtRisk && <CallsAtRiskList calls={callsAtRisk} hasFrontend={graph.frontendCalls.length > 0} />}
        </>
      )}

      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          File
        </h3>
        <code className="block break-all rounded bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-400">
          {mod.filePath}
        </code>
      </div>

      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Endpoints
        </h3>
        <p className="text-xs text-zinc-300">{mod.endpointCount}</p>
      </div>

      <RelationList
        title={`Imports (${imports.length})`}
        rows={imports}
        isMutual={isMutual}
        onSelect={onSelect}
        emptyText="Doesn't use any project module"
      />
      <RelationList
        title={`Imported by (${importedBy.length})`}
        rows={importedBy}
        isMutual={isMutual}
        onSelect={onSelect}
        emptyText="Not used by any project module"
      />
    </aside>
  );
}

const STATUS_STYLE: Record<string, string> = {
  A: 'text-emerald-400',
  M: 'text-amber-300',
  D: 'text-rose-400',
  R: 'text-sky-300',
};

function DiffPanel({
  diff,
  impact,
  graph,
  moduleById,
  onSelect,
  onClose,
}: {
  diff: DiffImpactResult;
  impact: ImpactResult;
  graph: GraphPayload;
  moduleById: Map<string, ModuleNodeData>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const groups = useMemo(() => {
    const byModule = new Map<string | null, ChangedFile[]>();
    for (const f of diff.changedFiles) {
      const list = byModule.get(f.moduleId) ?? [];
      list.push(f);
      byModule.set(f.moduleId, list);
    }
    const named = [...byModule.entries()]
      .filter(([id]) => id !== null)
      .sort((a, b) => (a[1][0].moduleName ?? '').localeCompare(b[1][0].moduleName ?? ''));
    return { named, outside: byModule.get(null) ?? [] };
  }, [diff]);

  const impactRows = useMemo(
    () =>
      [...impact.distance.entries()]
        .flatMap(([id, d]) => {
          const m = moduleById.get(id);
          return m ? [{ module: m, distance: d as number | undefined }] : [];
        })
        .sort(
          (a, b) =>
            (a.distance ?? 0) - (b.distance ?? 0) || a.module.name.localeCompare(b.module.name),
        ),
    [impact, moduleById],
  );

  const callsAtRisk = useMemo(
    () =>
      callSitesAtRisk(graph, new Set([...impact.roots, ...impact.distance.keys(), ...impact.globalReach])),
    [graph, impact],
  );

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[360px] flex-col gap-5 overflow-y-auto border-l border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-semibold text-zinc-100">Diff impact</h2>
          <span className="font-mono text-[11px] text-zinc-500">
            working tree vs {diff.base}
          </span>
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

      <ImpactSummaryCard
        impact={impact}
        direction="upstream"
        isGlobalRoot={[...impact.roots].some((id) => moduleById.get(id)?.isGlobal)}
        label={`Blast radius of ${diff.changedFiles.length} changed file(s)`}
      />

      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Changed modules ({groups.named.length})
        </h3>
        {groups.named.length === 0 ? (
          <p className="text-xs text-zinc-600">No changed file belongs to a module</p>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.named.map(([moduleId, files]) => (
              <div key={moduleId} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
                <button
                  onClick={() => moduleId && onSelect(moduleId)}
                  className="text-xs font-medium text-sky-300 transition hover:text-sky-200"
                >
                  {files[0].moduleName}
                </button>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {files.map((f) => (
                    <li key={f.path} className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-400">
                      <span className={`w-3 shrink-0 font-bold ${STATUS_STYLE[f.status] ?? 'text-zinc-500'}`}>
                        {f.status}
                      </span>
                      <span className="truncate" title={f.path}>
                        {f.path}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {groups.outside.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">
              Outside modules ({groups.outside.length}) — not counted in the blast radius
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {groups.outside.map((f) => (
                <li key={f.path} className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                  <span className={`w-3 shrink-0 font-bold ${STATUS_STYLE[f.status] ?? ''}`}>{f.status}</span>
                  <span className="truncate" title={f.path}>
                    {f.path}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <ImpactList
        title={`Affected modules (${impactRows.length})`}
        rows={impactRows}
        hue="rose"
        isMutual={() => false}
        onSelect={onSelect}
        emptyText="No other module depends on the changed ones"
      />
      {impact.globalReach.size > 0 && (
        <ImpactList
          title={`Global reach (${impact.globalReach.size})`}
          rows={[...impact.globalReach].flatMap((id) => {
            const m = moduleById.get(id);
            return m ? [{ module: m, distance: undefined }] : [];
          })}
          hue="rose"
          isMutual={() => false}
          onSelect={onSelect}
          emptyText=""
        />
      )}

      <CallsAtRiskList calls={callsAtRisk} hasFrontend={graph.frontendCalls.length > 0} />
    </aside>
  );
}

// ── Shared list pieces ────────────────────────────────────────────────────────

export function CallsAtRiskList({ calls, hasFrontend }: { calls: FrontendCall[]; hasFrontend: boolean }) {
  if (calls.length === 0) {
    return hasFrontend ? (
      <p className="text-xs text-zinc-600">No linked frontend call site hits the affected modules.</p>
    ) : null;
  }
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Frontend call sites at risk ({calls.length})
      </h3>
      <ul className="flex flex-col gap-1">
        {calls.slice(0, 30).map((c) => {
          const label = (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className={`rounded border px-1 py-px font-mono text-[9px] font-bold ${methodBadge(c.method)}`}>
                {c.method}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11px] text-zinc-300">
                  {c.resolvedPath ?? c.rawUrl}
                </span>
                <span className="block truncate text-[9px] text-zinc-500">
                  {c.callerSymbol} · {c.filePath.split(/[\\/]/).pop()}:{c.line}
                </span>
              </span>
            </span>
          );
          const cls =
            'flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-left transition hover:border-zinc-600';
          return (
            <li key={c.id}>
              {c.sourceUrl ? (
                <a href={c.sourceUrl} target="_blank" rel="noreferrer" className={cls} title="Open on GitHub">
                  {label}
                </a>
              ) : (
                <div className={cls} title={c.filePath}>
                  {label}
                </div>
              )}
            </li>
          );
        })}
        {calls.length > 30 && (
          <li className="px-1 text-[10px] text-zinc-600">+{calls.length - 30} more</li>
        )}
      </ul>
    </div>
  );
}

function fileEvidenceTitle(meta: CouplingMeta | undefined): string | undefined {
  if (!meta) return undefined;
  const sample = meta.files
    .slice(0, 8)
    .map((f) => `${f.from} → ${f.to}`)
    .join('\n');
  return `${meta.count} raw file import(s) cross this boundary:\n${sample}${meta.count > 8 ? '\n…' : ''}`;
}

function RelationList({
  title,
  rows,
  isMutual,
  onSelect,
  emptyText,
}: {
  title: string;
  rows: { module: ModuleNodeData; meta?: CouplingMeta; fileLevel: boolean }[];
  isMutual: (id: string) => boolean;
  onSelect: (id: string) => void;
  emptyText: string;
}) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-600">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.module.id}>
              <button
                onClick={() => onSelect(r.module.id)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-left transition hover:border-zinc-600"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-zinc-300">{r.module.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {r.fileLevel && (
                      <span
                        className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
                        title={fileEvidenceTitle(r.meta)}
                      >
                        file-level{r.meta ? ` ×${r.meta.count}` : ''}
                      </span>
                    )}
                    {isMutual(r.module.id) && (
                      <span
                        className="rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] text-amber-400"
                        title="Circular — both modules import each other"
                      >
                        ⇄ circular
                      </span>
                    )}
                  </span>
                </span>
                {r.meta?.symbols && r.meta.symbols.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1" title="Symbols crossing this boundary, with usage counts">
                    {r.meta.symbols.slice(0, 6).map((s) => (
                      <span
                        key={s.name}
                        className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400"
                      >
                        {s.name}
                        {s.count > 0 && <span className="text-zinc-500"> ×{s.count}</span>}
                      </span>
                    ))}
                    {r.meta.symbols.length > 6 && (
                      <span className="px-1 py-0.5 text-[9px] text-zinc-600">
                        +{r.meta.symbols.length - 6}
                      </span>
                    )}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ImpactList({
  title,
  rows,
  hue,
  isMutual,
  onSelect,
  emptyText,
}: {
  title: string;
  rows: { module: ModuleNodeData; distance?: number }[];
  hue: Hue;
  isMutual: (id: string) => boolean;
  onSelect: (id: string) => void;
  emptyText: string;
}) {
  const distanceChip =
    hue === 'rose' ? 'bg-rose-950/60 text-rose-300' : 'bg-emerald-950/60 text-emerald-300';
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      {rows.length === 0 ? (
        emptyText && <p className="text-xs text-zinc-600">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.module.id}>
              <button
                onClick={() => onSelect(r.module.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-left text-xs text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
              >
                <span className="truncate">{r.module.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {r.distance !== undefined && r.distance > 1 && (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${distanceChip}`} title={`${r.distance} steps away`}>
                      {r.distance} hops
                    </span>
                  )}
                  {r.distance === undefined && (
                    <span
                      className="rounded bg-violet-950/60 px-1.5 py-0.5 text-[10px] text-violet-300"
                      title="Reachable through @Global() semantics — no explicit import"
                    >
                      global
                    </span>
                  )}
                  {isMutual(r.module.id) && (
                    <span
                      className="rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] text-amber-400"
                      title="Circular — both modules import each other"
                    >
                      ⇄
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
