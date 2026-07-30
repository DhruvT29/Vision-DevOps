'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  CollectionsPayload,
  DbDiffResult,
  DbEntityNode,
  EnvironmentSummary,
  FkMeta,
  GraphPayload,
  ModuleNode as ModuleNodeData,
  ScanStatus,
  TableTouchMeta,
} from '@vision/shared';
import { api } from '@/lib/api';
import { layoutDependencyGraph } from '@/lib/dependency-layout';
import { methodBadge } from '@/lib/method-colors';
import { AppShell } from '@/components/AppShell';
import {
  callSitesAtRisk,
  CallsAtRiskList,
  FloatingDependencyEdge,
  IMPACT_NODE_STYLE,
  ImpactSummaryCard,
  Segmented,
  type ImpactResult,
} from '@/components/DependencyView';

const FK_COLOR = '#10b981'; // emerald — foreign-key relation
const TWO_WAY = '#f59e0b'; // amber — tables referencing each other
const DB_COLOR = '#22d3ee'; // cyan — from the live database's FK constraints
const HUE_COLOR = { rose: '#f43f5e', emerald: '#10b981' } as const;

// Node sizing — compact card vs expanded schema (column-list) card. The layout
// and the floating edges both read these, so they stay in sync with the DOM.
const COMPACT_SIZE = { w: 240, h: 64 };
const EXPANDED_W = 300;
const EXPANDED_HEADER_H = 52;
const EXPANDED_ROW_H = 24;
const EXPANDED_PAD = 10;

function tableNodeSize(entity: DbEntityNode, expanded: boolean): { w: number; h: number } {
  if (!expanded) return COMPACT_SIZE;
  const rows = Math.max(entity.columns.length, 1);
  return { w: EXPANDED_W, h: EXPANDED_HEADER_H + rows * EXPANDED_ROW_H + EXPANDED_PAD };
}

type Direction = 'upstream' | 'downstream';
type ImpactTier = 'direct' | 'indirect' | 'global';
type Hue = 'rose' | 'emerald';

/** how a module accesses a table — 'owns' is implied by folder ownership */
const VIA_BADGE: Record<string, string> = {
  owns: 'bg-emerald-950/70 text-emerald-300',
  repository: 'bg-sky-950/70 text-sky-300',
  relation: 'bg-violet-950/70 text-violet-300',
  import: 'bg-zinc-800 text-zinc-400',
  'raw-sql': 'bg-amber-950/70 text-amber-300',
};

type TableFlowNode = Node<
  {
    entity: DbEntityNode;
    ownerName?: string;
    selected: boolean;
    dimmed: boolean;
    expanded: boolean;
    impact?: ImpactTier;
    hue: Hue;
  },
  'table'
>;

function DbGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3 shrink-0 text-emerald-500/80">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

/** small key glyph marking a foreign-key column on the expanded card */
function FkGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-2.5 w-2.5 shrink-0 text-amber-400/90" aria-hidden>
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 6 6M15 15l2-2M17 17l2-2" />
    </svg>
  );
}

function TableGraphNode({ data }: NodeProps<TableFlowNode>) {
  const { entity, ownerName, selected, dimmed, expanded, impact, hue } = data;
  const border = selected
    ? 'border-sky-500/70 bg-sky-950/50 shadow-lg shadow-sky-500/15'
    : impact
      ? IMPACT_NODE_STYLE[hue][impact]
      : 'border-emerald-500/25 bg-[rgba(16,60,45,0.12)] hover:border-emerald-400/60 hover:shadow-[0_0_40px_-6px_rgba(16,185,129,0.5)]';

  const handles = (
    <>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </>
  );

  if (!expanded) {
    return (
      <div
        style={{ width: COMPACT_SIZE.w, height: COMPACT_SIZE.h }}
        className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 backdrop-blur-xl transition ${border} ${
          dimmed ? 'opacity-20' : ''
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <DbGlyph />
            <span className="truncate font-mono text-sm font-semibold text-zinc-100">
              {entity.tableName}
            </span>
          </div>
          <div className="truncate text-[10px] uppercase tracking-wider text-emerald-500/80">
            table{ownerName ? ` · ${ownerName.replace(/Module$/, '')}` : ''}
          </div>
        </div>
        <span
          className="ml-2 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300"
          title={`${entity.columns.length} columns`}
        >
          {entity.columns.length}
        </span>
        {handles}
      </div>
    );
  }

  return (
    <div
      style={{ width: EXPANDED_W }}
      className={`flex cursor-pointer flex-col overflow-hidden rounded-xl border backdrop-blur-xl transition ${border} ${
        dimmed ? 'opacity-20' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <DbGlyph />
          <span className="truncate font-mono text-sm font-semibold text-zinc-100">
            {entity.tableName}
          </span>
        </div>
        {ownerName && (
          <span className="shrink-0 truncate text-[9px] uppercase tracking-wider text-emerald-500/80">
            {ownerName.replace(/Module$/, '')}
          </span>
        )}
      </div>
      <div className="flex flex-col py-1">
        {entity.columns.length === 0 && (
          <div className="px-3 py-1 text-[10px] text-zinc-600">no columns detected</div>
        )}
        {entity.columns.map((c) => (
          <div
            key={c.name}
            style={{ height: EXPANDED_ROW_H }}
            className="flex items-center justify-between gap-2 px-3"
            title={c.refTable ? `${c.name} → ${c.refTable}` : c.name}
          >
            <span className="flex min-w-0 items-center gap-1">
              {c.isForeignKey && <FkGlyph />}
              <span
                className={`truncate font-mono text-[11px] ${
                  c.isPrimaryKey ? 'font-semibold text-amber-200' : 'text-zinc-300'
                }`}
              >
                {c.name}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {c.type && (
                <span className="max-w-[110px] truncate font-mono text-[10px] text-zinc-600">
                  {c.type}
                </span>
              )}
              {c.isPrimaryKey && (
                <span className="rounded bg-amber-950/70 px-1 py-px text-[8px] font-bold tracking-wide text-amber-300" title="Primary key">
                  PK
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      {handles}
    </div>
  );
}

const dbNodeTypes = { table: TableGraphNode };
const dbEdgeTypes = { floating: FloatingDependencyEdge };

/**
 * Intra-DB blast: BFS across FK relations only. Upstream = tables that
 * reference the roots (directly or transitively) — what a schema change
 * ripples into; downstream = tables the roots reference. Same scoring model
 * as the module impact, without @Global semantics (tables have none).
 */
function computeTableImpact(
  rootIds: string[],
  direction: Direction,
  totalTables: number,
  forward: Map<string, Set<string>>,
  reverse: Map<string, Set<string>>,
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

  const direct = [...distance.values()].filter((x) => x === 1).length;
  const total = distance.size;
  const others = Math.max(1, totalTables - roots.size);
  const pct = total / others;
  let score = direct;
  distance.forEach((dist) => {
    if (dist > 1) score += 1 / dist;
  });
  let centrality = 0;
  for (const id of roots) {
    centrality += (forward.get(id)?.size ?? 0) + (reverse.get(id)?.size ?? 0);
  }
  const level =
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
    globalReach: new Set(),
    direct,
    total,
    pct,
    score: Math.round(score * 10) / 10,
    centrality,
    level,
  };
}

interface Toucher {
  module: ModuleNodeData;
  via: string[];
  files?: string[];
}

export function DbBlastView({ snapshotId }: { snapshotId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<ScanStatus>('pending');
  const [scanError, setScanError] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([]);
  const [direction, setDirection] = useState<Direction>('upstream');
  const [migration, setMigration] = useState<DbDiffResult | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedTableIds([]);
    setMigration(null);
  }, []);

  // remember the expand toggle across sessions
  useEffect(() => {
    setExpanded(localStorage.getItem('vision:db-blast-expanded') === '1');
  }, []);
  useEffect(() => {
    localStorage.setItem('vision:db-blast-expanded', expanded ? '1' : '0');
  }, [expanded]);

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
      router.push(`/db-blast/${res.snapshot.id}`);
    } catch (e) {
      setRescanError(e instanceof Error ? e.message : String(e));
      setRescanning(false);
    }
  }, [graph, rescanning, router]);

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

  const entities = useMemo(() => graph?.entities ?? [], [graph]);
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const moduleById = useMemo(
    () => new Map(graph?.modules.map((m) => [m.id, m]) ?? []),
    [graph],
  );
  const fkEdges = useMemo(() => graph?.edges.filter((e) => e.type === 'fk') ?? [], [graph]);
  const fkCounts = useMemo(() => {
    let inferred = 0;
    let fromDb = 0;
    for (const e of fkEdges) {
      const m = e.meta as FkMeta | undefined;
      if (m?.inferred) inferred++;
      if (m?.origin === 'db') fromDb++;
    }
    return { inferred, fromDb };
  }, [fkEdges]);
  const touchEdges = useMemo(
    () => graph?.edges.filter((e) => e.type === 'touches-table') ?? [],
    [graph],
  );
  const fkKeys = useMemo(
    () => new Set(fkEdges.map((e) => `${e.sourceId}->${e.targetId}`)),
    [fkEdges],
  );
  const { forward, reverse } = useMemo(() => {
    const forward = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, a: string, b: string) => {
      let set = map.get(a);
      if (!set) map.set(a, (set = new Set()));
      set.add(b);
    };
    for (const e of fkEdges) {
      add(forward, e.sourceId, e.targetId);
      add(reverse, e.targetId, e.sourceId);
    }
    return { forward, reverse };
  }, [fkEdges]);

  // entityId → modules touching its table (owner first, then touch edges)
  const touchersByEntity = useMemo(() => {
    const map = new Map<string, Toucher[]>();
    for (const ent of entities) {
      const rows: Toucher[] = [];
      if (ent.moduleId) {
        const owner = moduleById.get(ent.moduleId);
        if (owner) rows.push({ module: owner, via: ['owns'] });
      }
      map.set(ent.id, rows);
    }
    for (const e of touchEdges) {
      const mod = moduleById.get(e.sourceId);
      const rows = map.get(e.targetId);
      if (!mod || !rows) continue;
      const meta = e.meta as TableTouchMeta | undefined;
      rows.push({ module: mod, via: meta?.via ?? [], files: meta?.files });
    }
    return map;
  }, [entities, touchEdges, moduleById]);

  // ── Intra-DB blast: FK ripple only ─────────────────────────────────────────
  const effDirection: Direction = migration ? 'upstream' : direction;
  const hue: Hue = effDirection === 'upstream' ? 'rose' : 'emerald';

  const impact = useMemo<ImpactResult | null>(() => {
    if (selectedTableIds.length === 0) return null;
    return computeTableImpact(selectedTableIds, effDirection, entities.length, forward, reverse);
  }, [selectedTableIds, effDirection, entities.length, forward, reverse]);

  const affectedTableIds = useMemo(
    () => (impact ? new Set([...impact.roots, ...impact.distance.keys()]) : null),
    [impact],
  );

  // code exposure: modules DIRECTLY touching any affected table — no
  // module→module ripple, per the intra-DB scope of this page
  const exposure = useMemo(() => {
    if (!graph || !affectedTableIds || effDirection !== 'upstream') return null;
    const byModule = new Map<string, Toucher>();
    for (const tid of affectedTableIds) {
      for (const t of touchersByEntity.get(tid) ?? []) {
        const existing = byModule.get(t.module.id);
        if (existing) existing.via = [...new Set([...existing.via, ...t.via])];
        else byModule.set(t.module.id, { ...t, via: [...t.via] });
      }
    }
    const touchers = [...byModule.values()].sort((a, b) =>
      a.module.name.localeCompare(b.module.name),
    );
    const moduleIds = new Set(byModule.keys());
    const endpoints = graph.endpoints
      .filter((ep) => moduleIds.has(ep.moduleId))
      .sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    const calls = callSitesAtRisk(graph, moduleIds);
    return { touchers, endpoints, calls };
  }, [graph, affectedTableIds, effDirection, touchersByEntity]);

  // ── Canvas: tables only ────────────────────────────────────────────────────
  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };

    const q = search.toLowerCase();
    const visibleTables = entities.filter(
      (e) =>
        q === '' || e.tableName.toLowerCase().includes(q) || e.name.toLowerCase().includes(q),
    );
    const visibleIds = new Set(visibleTables.map((e) => e.id));
    const selectedSet = new Set(selectedTableIds);
    const blastActive = !!impact;

    const sizeById = new Map<string, { w: number; h: number }>();
    const nodes: Node[] = visibleTables.map((e) => {
      let tier: ImpactTier | undefined;
      let dimmed = false;
      if (blastActive && impact && !selectedSet.has(e.id)) {
        const d = impact.distance.get(e.id);
        tier = d === 1 ? 'direct' : d ? 'indirect' : undefined;
        dimmed = !tier;
      }
      const size = tableNodeSize(e, expanded);
      sizeById.set(e.id, size);
      return {
        id: e.id,
        type: 'table' as const,
        position: { x: 0, y: 0 },
        // explicit size keeps the force layout, the DOM, and the floating edges
        // (which read node.measured) all in agreement for tall expanded cards
        width: size.w,
        height: size.h,
        data: {
          entity: e,
          ownerName: e.moduleId ? moduleById.get(e.moduleId)?.name : undefined,
          selected: selectedSet.has(e.id),
          dimmed,
          expanded,
          impact: tier,
          hue,
        },
      };
    });

    const impactedIds = affectedTableIds;
    const edges: Edge[] = fkEdges.flatMap((e) => {
      if (!visibleIds.has(e.sourceId) || !visibleIds.has(e.targetId)) return [];
      const meta = e.meta as FkMeta | undefined;
      const fromDb = meta?.origin === 'db';
      const inferred = meta?.inferred === true;
      const mutual = fkKeys.has(`${e.targetId}->${e.sourceId}`);
      const onPath = !!impactedIds && impactedIds.has(e.sourceId) && impactedIds.has(e.targetId);
      const dim = blastActive && !onPath;
      const color = onPath
        ? HUE_COLOR[hue]
        : fromDb
          ? DB_COLOR
          : mutual
            ? TWO_WAY
            : FK_COLOR;
      return [
        {
          id: e.id,
          source: e.sourceId,
          target: e.targetId,
          type: 'floating' as const,
          animated: onPath,
          data: { offset: mutual ? 11 : 0 },
          style: {
            stroke: color,
            strokeWidth: onPath ? 2 : 1.5,
            // heuristic (inferred) FKs are drawn dashed and a touch fainter
            strokeDasharray: inferred ? '5 4' : undefined,
            opacity: dim ? 0.06 : inferred ? 0.5 : 0.65,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        },
      ];
    });

    return { nodes: layoutDependencyGraph(nodes, edges, sizeById), edges };
  }, [graph, entities, fkEdges, fkKeys, moduleById, impact, affectedTableIds, hue, selectedTableIds, search, expanded]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setMigration(null);
    setSelectedTableIds((prev) => (prev.length === 1 && prev[0] === node.id ? [] : [node.id]));
  }, []);

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

  const selectedTable =
    selectedTableIds.length === 1 && !migration ? entityById.get(selectedTableIds[0]) : undefined;

  return (
    <AppShell snapshotId={snapshotId} stats={graph.snapshot.stats}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tables…"
            spellCheck={false}
            className="w-44 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
          {!migration && (
            <Segmented
              value={direction}
              onChange={setDirection}
              options={[
                {
                  value: 'upstream',
                  label: 'Affected by it',
                  title: 'Tables that reference this one (directly or transitively) — what a change here ripples into',
                },
                {
                  value: 'downstream',
                  label: 'It depends on',
                  title: 'Tables this one references through its foreign keys',
                },
              ]}
            />
          )}
          <MigrationControl
            snapshotId={snapshotId}
            migration={migration}
            onResult={(res) => {
              setMigration(res);
              setSelectedTableIds(res.matchedEntityIds);
            }}
            onClear={clearSelection}
          />
          <button
            onClick={() => setExpanded((v) => !v)}
            title="Expand every table into its full column list (schema view)"
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
              expanded
                ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200'
                : 'border-zinc-800 text-zinc-300 hover:border-zinc-600'
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              {expanded ? (
                <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
              ) : (
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              )}
            </svg>
            {expanded ? 'Collapse' : 'Expand schemas'}
          </button>
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 xl:flex" title="Foreign-key relation declared in code">
            <span className="inline-block h-0.5 w-5 rounded bg-emerald-500/80" />
            FK relation
          </span>
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 xl:flex" title="Heuristic guess — an implicit `xxxId` column with no declared relation">
            <svg width="20" height="2" className="shrink-0">
              <line x1="0" y1="1" x2="20" y2="1" stroke="#10b981" strokeWidth="2" strokeDasharray="4 3" opacity="0.8" />
            </svg>
            inferred
          </span>
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 xl:flex" title="Foreign key read from the live database's constraints (DB Schema section)">
            <span className="inline-block h-0.5 w-5 rounded bg-cyan-400/80" />
            live DB
          </span>
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 xl:flex" title="Two tables referencing each other">
            <span className="inline-block h-0.5 w-5 rounded bg-amber-500/80" />
            circular
          </span>
          <span className="hidden items-center gap-1.5 text-[11px] text-zinc-500 2xl:flex" title="On the blast path of the selected table">
            <span className="inline-block h-0.5 w-5 rounded bg-rose-500/80" />
            at risk
          </span>
          <span className="ml-auto flex items-center gap-3">
            {rescanError && <span className="text-xs text-red-400">{rescanError}</span>}
            <button
              onClick={rescan}
              disabled={rescanning}
              title="Re-analyze the project and rebuild this graph"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-600 disabled:cursor-default disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3.5 w-3.5 ${rescanning ? 'animate-spin' : ''}`}>
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
              {rescanning ? 'Rescanning…' : 'Rescan'}
            </button>
            <span className="whitespace-nowrap text-xs text-zinc-500">
              {entities.length} tables · {fkEdges.length} relations
              {fkCounts.inferred > 0 && ` · ${fkCounts.inferred} inferred`}
              {fkCounts.fromDb > 0 && ` · ${fkCounts.fromDb} from DB`}
            </span>
          </span>
        </div>
        {entities.length === 0 && (
          <div className="border-b border-amber-900/40 bg-amber-950/20 px-4 py-2 text-xs text-amber-300/90">
            No database entities in this snapshot. If the project uses TypeORM @Entity classes,
            hit <span className="font-semibold">Rescan</span> (top right) — snapshots from before
            the DB layer don&apos;t carry them.
          </div>
        )}
        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={dbNodeTypes}
              edgeTypes={dbEdgeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={clearSelection}
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
                  (n.data as { selected?: boolean })?.selected ? '#0ea5e9' : '#065f46'
                }
                maskColor="rgba(9,9,11,0.7)"
              />
            </ReactFlow>
          </div>
          {migration && impact ? (
            <MigrationPanel
              migration={migration}
              impact={impact}
              graph={graph}
              entityById={entityById}
              exposure={exposure}
              onFocusTable={(id) => {
                setMigration(null);
                setSelectedTableIds([id]);
              }}
              onClose={clearSelection}
            />
          ) : (
            selectedTable &&
            impact && (
              <TablePanel
                entity={selectedTable}
                impact={impact}
                direction={effDirection}
                graph={graph}
                entityById={entityById}
                moduleById={moduleById}
                touchers={touchersByEntity.get(selectedTable.id) ?? []}
                exposure={exposure}
                onSelectTable={(id) => {
                  setMigration(null);
                  setSelectedTableIds([id]);
                }}
                onClose={clearSelection}
              />
            )
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── Migration control (toolbar popover) ───────────────────────────────────────

function MigrationControl({
  snapshotId,
  migration,
  onResult,
  onClear,
}: {
  snapshotId: string;
  migration: DbDiffResult | null;
  onResult: (r: DbDiffResult) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'file' | 'sql'>('file');
  const [files, setFiles] = useState<string[] | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (files === null) {
      api
        .migrationFiles(snapshotId)
        .then(setFiles)
        .catch(() => setFiles([]));
    }
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
  }, [open, files, snapshotId]);

  const analyze = async (body: { sql?: string; migrationPath?: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.dbDiff(snapshotId, body);
      if (res.matchedEntityIds.length === 0) {
        setError(
          res.tables.length === 0
            ? 'No table references found'
            : `No known entity matches: ${res.tables.join(', ')}`,
        );
      } else {
        onResult(res);
        setOpen(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (migration) {
    return (
      <span className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-2.5 py-1 text-xs text-emerald-200">
        <MigrationIcon />
        {migration.source === 'sql' ? 'pasted SQL' : migration.source.split('/').pop()}:{' '}
        {migration.matchedEntityIds.length} tables
        {migration.unmatched.length > 0 && ` (+${migration.unmatched.length} unknown)`}
        <button
          onClick={onClear}
          aria-label="Clear migration impact"
          className="ml-1 rounded p-0.5 text-emerald-300 transition hover:bg-emerald-900/60 hover:text-emerald-100"
        >
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </span>
    );
  }

  const visibleFiles = (files ?? []).filter(
    (f) => fileFilter === '' || f.toLowerCase().includes(fileFilter.toLowerCase()),
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Blast radius of an actual schema migration — pick a migration file or paste SQL"
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
          open
            ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200'
            : 'border-zinc-800 text-zinc-300 hover:border-zinc-600'
        }`}
      >
        <MigrationIcon />
        Migration impact
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-96 rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-xl shadow-black/50">
          <p className="text-xs font-semibold text-zinc-200">Impact of a schema migration</p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Extracts the tables the migration touches (parsed, never executed) and computes their
            combined blast radius.
          </p>
          <div className="mt-2">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'file', label: 'Migration file' },
                { value: 'sql', label: 'Paste SQL' },
              ]}
            />
          </div>
          {tab === 'file' ? (
            <div className="mt-2">
              {files === null ? (
                <p className="py-2 text-[11px] text-zinc-500">Scanning for migration files…</p>
              ) : files.length === 0 ? (
                <p className="py-2 text-[11px] text-zinc-500">
                  No migration files found in the project — paste SQL instead.
                </p>
              ) : (
                <>
                  <input
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder="Filter files…"
                    spellCheck={false}
                    className="w-full rounded-md border border-transparent bg-zinc-950 px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-700"
                  />
                  <ul className="mt-1 max-h-48 overflow-y-auto py-1">
                    {visibleFiles.length === 0 && (
                      <li className="px-2 py-1.5 text-xs text-zinc-500">No files match</li>
                    )}
                    {visibleFiles.map((f) => (
                      <li key={f}>
                        <button
                          onClick={() => analyze({ migrationPath: f })}
                          disabled={busy}
                          className="w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
                          title={f}
                        >
                          {f}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : (
            <>
              <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                placeholder={'ALTER TABLE users ADD COLUMN phone varchar;\nDROP TABLE sessions;'}
                spellCheck={false}
                rows={5}
                className="mt-2 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
              <button
                onClick={() => analyze({ sql })}
                disabled={busy || !sql.trim()}
                className="mt-2 w-full rounded-md border border-emerald-500/40 bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-950/70 disabled:opacity-50"
              >
                {busy ? 'Analyzing…' : 'Analyze SQL'}
              </button>
            </>
          )}
          {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}

function MigrationIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M12 17v5M9.5 19.5 12 22l2.5-2.5" />
    </svg>
  );
}

// ── Panels ────────────────────────────────────────────────────────────────────

function PanelShell({
  children,
  onClose,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
}) {
  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-[360px] flex-col gap-5 overflow-y-auto border-l border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="break-all text-sm font-semibold text-zinc-100">{title}</h2>
          {subtitle && <div className="text-[11px] text-zinc-500">{subtitle}</div>}
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
      {children}
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </h3>
  );
}

/** FK-ripple rows: affected/referenced tables, ordered by distance. */
function TableImpactList({
  title,
  rows,
  hue,
  onSelect,
  emptyText,
}: {
  title: string;
  rows: { entity: DbEntityNode; distance: number }[];
  hue: Hue;
  onSelect: (id: string) => void;
  emptyText: string;
}) {
  const distanceChip =
    hue === 'rose' ? 'bg-rose-950/60 text-rose-300' : 'bg-emerald-950/60 text-emerald-300';
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-600">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.entity.id}>
              <button
                onClick={() => onSelect(r.entity.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-left transition hover:border-zinc-600"
                title="Analyze this table"
              >
                <span className="truncate font-mono text-xs text-zinc-300">
                  {r.entity.tableName}
                </span>
                {r.distance > 1 && (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${distanceChip}`} title={`${r.distance} FK hops away`}>
                    {r.distance} hops
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

function TouchersList({ title, touchers }: { title: string; touchers: Toucher[] }) {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      {touchers.length === 0 ? (
        <p className="text-xs text-zinc-600">No module accesses these tables</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {touchers.map((t) => (
            <li
              key={t.module.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5"
              title={t.files?.join('\n')}
            >
              <span className="truncate text-xs text-zinc-300">{t.module.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                {t.via.map((v) => (
                  <span key={v} className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${VIA_BADGE[v] ?? 'bg-zinc-800 text-zinc-400'}`}>
                    {v}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EndpointsAtRiskList({ endpoints }: { endpoints: GraphPayload['endpoints'] }) {
  if (endpoints.length === 0) return null;
  return (
    <div>
      <SectionTitle>Endpoints at risk ({endpoints.length})</SectionTitle>
      <ul className="flex flex-col gap-1">
        {endpoints.slice(0, 20).map((ep) => {
          const label = (
            <>
              <span className={`rounded border px-1 py-px font-mono text-[9px] font-bold ${methodBadge(ep.method)}`}>
                {ep.method}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">
                {ep.fullPath}
              </span>
            </>
          );
          const cls =
            'flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-left transition hover:border-zinc-600';
          return (
            <li key={ep.id}>
              {ep.sourceUrl ? (
                <a href={ep.sourceUrl} target="_blank" rel="noreferrer" className={cls} title="Open on GitHub">
                  {label}
                </a>
              ) : (
                <div className={cls}>{label}</div>
              )}
            </li>
          );
        })}
        {endpoints.length > 20 && (
          <li className="px-1 text-[10px] text-zinc-600">+{endpoints.length - 20} more</li>
        )}
      </ul>
    </div>
  );
}

/** read-only "who is exposed in code" block — kept out of the blast math */
function CodeExposure({
  graph,
  exposure,
}: {
  graph: GraphPayload;
  exposure: { touchers: Toucher[]; endpoints: GraphPayload['endpoints']; calls: ReturnType<typeof callSitesAtRisk> } | null;
}) {
  if (!exposure) return null;
  return (
    <>
      <div className="border-t border-zinc-800 pt-4">
        <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
          Code exposure — modules directly touching the affected tables (shown for context, not
          part of the table ripple):
        </p>
        <TouchersList title={`Touching modules (${exposure.touchers.length})`} touchers={exposure.touchers} />
      </div>
      <EndpointsAtRiskList endpoints={exposure.endpoints} />
      <CallsAtRiskList calls={exposure.calls} hasFrontend={graph.frontendCalls.length > 0} />
      <SmokeTestSection
        projectId={graph.snapshot.projectId}
        endpointIds={new Set(exposure.endpoints.map((e) => e.id))}
      />
    </>
  );
}

function rippleRows(
  impact: ImpactResult,
  entityById: Map<string, DbEntityNode>,
): { entity: DbEntityNode; distance: number }[] {
  return [...impact.distance.entries()]
    .flatMap(([id, d]) => {
      const ent = entityById.get(id);
      return ent ? [{ entity: ent, distance: d }] : [];
    })
    .sort((a, b) => a.distance - b.distance || a.entity.tableName.localeCompare(b.entity.tableName));
}

function TablePanel({
  entity,
  impact,
  direction,
  graph,
  entityById,
  moduleById,
  touchers,
  exposure,
  onSelectTable,
  onClose,
}: {
  entity: DbEntityNode;
  impact: ImpactResult;
  direction: Direction;
  graph: GraphPayload;
  entityById: Map<string, DbEntityNode>;
  moduleById: Map<string, ModuleNodeData>;
  touchers: Toucher[];
  exposure: { touchers: Toucher[]; endpoints: GraphPayload['endpoints']; calls: ReturnType<typeof callSitesAtRisk> } | null;
  onSelectTable: (id: string) => void;
  onClose: () => void;
}) {
  const rows = rippleRows(impact, entityById);
  const hue: Hue = direction === 'upstream' ? 'rose' : 'emerald';

  return (
    <PanelShell
      onClose={onClose}
      title={<span className="font-mono">{entity.tableName}</span>}
      subtitle={
        <>
          {entity.name}
          {entity.moduleId && ` · ${moduleById.get(entity.moduleId)?.name ?? ''}`}
          {entity.sourceUrl && (
            <>
              {' · '}
              <a href={entity.sourceUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                source
              </a>
            </>
          )}
        </>
      }
    >
      <ImpactSummaryCard
        impact={impact}
        direction={direction}
        isGlobalRoot={false}
        label={
          direction === 'upstream'
            ? `FK blast radius of changing "${entity.tableName}"`
            : `Tables "${entity.tableName}" references`
        }
      />

      <div>
        <SectionTitle>Columns ({entity.columns.length})</SectionTitle>
        <div className="flex flex-wrap gap-1">
          {entity.columns.map((c) => (
            <span key={c.name} className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
              {c.name}
              {c.type && <span className="text-zinc-600">: {c.type}</span>}
            </span>
          ))}
          {entity.columns.length === 0 && <span className="text-xs text-zinc-600">none detected</span>}
        </div>
      </div>

      <TableImpactList
        title={
          direction === 'upstream'
            ? `Tables affected (${rows.length})`
            : `Tables it references (${rows.length})`
        }
        rows={rows}
        hue={hue}
        onSelect={onSelectTable}
        emptyText={
          direction === 'upstream'
            ? 'No table references this one — schema changes stay local'
            : 'No outgoing foreign keys'
        }
      />

      <TouchersList title={`Touches this table (${touchers.length})`} touchers={touchers} />

      {direction === 'upstream' && <CodeExposure graph={graph} exposure={exposure} />}
    </PanelShell>
  );
}

function MigrationPanel({
  migration,
  impact,
  graph,
  entityById,
  exposure,
  onFocusTable,
  onClose,
}: {
  migration: DbDiffResult;
  impact: ImpactResult;
  graph: GraphPayload;
  entityById: Map<string, DbEntityNode>;
  exposure: { touchers: Toucher[]; endpoints: GraphPayload['endpoints']; calls: ReturnType<typeof callSitesAtRisk> } | null;
  onFocusTable: (id: string) => void;
  onClose: () => void;
}) {
  const rows = rippleRows(impact, entityById);

  return (
    <PanelShell
      onClose={onClose}
      title="Migration impact"
      subtitle={<span className="font-mono">{migration.source}</span>}
    >
      <ImpactSummaryCard
        impact={impact}
        direction="upstream"
        isGlobalRoot={false}
        label={`FK blast radius of ${migration.matchedEntityIds.length} table(s)`}
      />

      <div>
        <SectionTitle>Tables changed ({migration.matchedEntityIds.length})</SectionTitle>
        <ul className="flex flex-col gap-1">
          {migration.matchedEntityIds.map((id) => {
            const ent = entityById.get(id);
            if (!ent) return null;
            return (
              <li key={id}>
                <button
                  onClick={() => onFocusTable(id)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-left transition hover:border-zinc-600"
                  title="Focus this table"
                >
                  <span className="truncate font-mono text-xs text-emerald-300">{ent.tableName}</span>
                  <span className="shrink-0 text-[10px] text-zinc-500">{ent.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {migration.unmatched.length > 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            No matching entity for:{' '}
            <span className="font-mono text-zinc-400">{migration.unmatched.join(', ')}</span> —
            these tables aren&apos;t covered by the analysis.
          </p>
        )}
      </div>

      <TableImpactList
        title={`Tables affected (${rows.length})`}
        rows={rows}
        hue="rose"
        onSelect={onFocusTable}
        emptyText="No other table references the changed ones"
      />

      <CodeExposure graph={graph} exposure={exposure} />
    </PanelShell>
  );
}

// ── Smoke tests: run saved requests linked to the at-risk endpoints ───────────

interface SmokeResult {
  id: string;
  name: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

function SmokeTestSection({
  projectId,
  endpointIds,
}: {
  projectId: string;
  endpointIds: Set<string>;
}) {
  const [collections, setCollections] = useState<CollectionsPayload | null>(null);
  const [envs, setEnvs] = useState<EnvironmentSummary[]>([]);
  const [envId, setEnvId] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SmokeResult[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.collections(projectId).catch(() => null),
      api.listEnvironments(projectId).catch(() => [] as EnvironmentSummary[]),
    ]).then(([cols, envList]) => {
      if (cancelled) return;
      setCollections(cols);
      setEnvs(envList);
      setEnvId((prev) => prev || (envList[0]?.id ?? ''));
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const linked = useMemo(
    () =>
      collections
        ? collections.requests.filter((r) => r.endpointId && endpointIds.has(r.endpointId))
        : null,
    [collections, endpointIds],
  );

  async function run() {
    if (!linked || linked.length === 0 || running) return;
    setRunning(true);
    setResults([]);
    const out: SmokeResult[] = [];
    for (const req of linked) {
      try {
        const res = await api.runSavedRequest(req.id, envId || undefined);
        const ok =
          !res.result.error &&
          (res.assertions.length > 0
            ? res.assertions.every((a) => a.passed)
            : !!res.result.status && res.result.status < 400);
        out.push({
          id: req.id,
          name: req.name,
          ok,
          status: res.result.status,
          ms: res.result.durationMs,
          error: res.result.error,
        });
      } catch (e) {
        out.push({
          id: req.id,
          name: req.name,
          ok: false,
          ms: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      setResults([...out]);
    }
    setRunning(false);
  }

  const passed = results?.filter((r) => r.ok).length ?? 0;

  return (
    <div>
      <SectionTitle>Smoke test</SectionTitle>
      {linked === null ? (
        <p className="text-xs text-zinc-600">Loading saved requests…</p>
      ) : linked.length === 0 ? (
        <p className="text-xs leading-relaxed text-zinc-600">
          No saved requests are linked to the at-risk endpoints. Save requests from the endpoint
          panel (Test tab) to smoke-test this blast radius with one click.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {envs.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {envs.map((env) => (
                <button
                  key={env.id}
                  onClick={() => setEnvId(env.id)}
                  className={`rounded border px-2 py-0.5 text-[10px] transition ${
                    envId === env.id
                      ? 'border-sky-500/50 bg-sky-950/50 text-sky-300'
                      : 'border-zinc-800 text-zinc-500 hover:border-zinc-600'
                  }`}
                >
                  {env.name}
                </button>
              ))}
            </div>
          )}
          {envs.length === 0 && (
            <p className="text-[11px] text-zinc-600">
              No environment configured — requests will run with their saved URLs as-is.
            </p>
          )}
          <button
            onClick={run}
            disabled={running}
            className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-950/70 disabled:opacity-50"
          >
            {running
              ? `Running… (${results?.length ?? 0}/${linked.length})`
              : `Run ${linked.length} saved request${linked.length === 1 ? '' : 's'}`}
          </button>
          {results && results.length > 0 && (
            <>
              <p className="text-[11px] text-zinc-500">
                {passed}/{results.length} passed
              </p>
              <ul className="flex flex-col gap-1">
                {results.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5"
                    title={r.error}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${r.ok ? 'bg-emerald-500' : 'bg-rose-500'}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{r.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                      {r.error ? 'error' : (r.status ?? '—')} · {r.ms}ms
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
