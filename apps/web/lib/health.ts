import type { GraphPayload } from '@vision/shared';

export interface HealthFactor {
  label: string;
  /** points deducted from 100 */
  penalty: number;
  detail: string;
}

export interface HealthReport {
  score: number; // 0..100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  factors: HealthFactor[];
}

/**
 * A–F codebase grade from the module graph — CodeFlow's calcHealth idea
 * adapted to Vision's module-level, AST-accurate data. Every factor names its
 * offenders so the grade is actionable rather than judgmental.
 */
export function computeHealth(graph: GraphPayload): HealthReport {
  const modules = graph.modules;
  const byId = new Map(modules.map((m) => [m.id, m]));
  const dep = graph.edges.filter((e) => e.type === 'imports' || e.type === 'file-imports');
  const fileLevel = dep.filter((e) => e.type === 'file-imports');
  const keys = new Set(dep.map((e) => `${e.sourceId}->${e.targetId}`));
  const factors: HealthFactor[] = [];

  // circular dependencies — the strongest structural smell
  const seenPairs = new Set<string>();
  const circular: string[] = [];
  for (const e of dep) {
    if (!keys.has(`${e.targetId}->${e.sourceId}`)) continue;
    const pairKey = [e.sourceId, e.targetId].sort().join('|');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    circular.push(`${byId.get(e.sourceId)?.name ?? '?'} ⇄ ${byId.get(e.targetId)?.name ?? '?'}`);
  }
  if (circular.length > 0) {
    factors.push({
      label: 'Circular dependencies',
      penalty: Math.min(20, circular.length * 5),
      detail: circular.join(' · '),
    });
  }

  // hidden coupling — file imports that bypass the module wiring
  if (fileLevel.length > 0) {
    const pct = Math.round((fileLevel.length / dep.length) * 100);
    factors.push({
      label: 'Hidden coupling',
      penalty: Math.min(15, fileLevel.length * 2),
      detail: `${fileLevel.length} file-level dependencies bypass @Module wiring (${pct}% of all coupling)`,
    });
  }

  // coupling hotspots — modules many others depend on (high in-degree)
  const inDeg = new Map<string, number>();
  for (const e of dep) inDeg.set(e.targetId, (inDeg.get(e.targetId) ?? 0) + 1);
  const hotspots = modules
    .filter((m) => (inDeg.get(m.id) ?? 0) >= 5)
    .map((m) => `${m.name} (imported by ${inDeg.get(m.id)})`);
  if (hotspots.length > 0) {
    factors.push({
      label: 'Coupling hotspots',
      penalty: Math.min(15, hotspots.length * 3),
      detail: hotspots.join(' · '),
    });
  }

  // god modules — one module owning an outsized share of the API surface
  const totalEndpoints = graph.endpoints.length;
  const god = modules
    .filter((m) => totalEndpoints >= 20 && m.endpointCount > totalEndpoints * 0.3)
    .map((m) => `${m.name} (${m.endpointCount} of ${totalEndpoints} endpoints)`);
  if (god.length > 0) {
    factors.push({
      label: 'God modules',
      penalty: Math.min(12, god.length * 4),
      detail: god.join(' · '),
    });
  }

  // @Global() modules — every change to them can affect everything
  const globals = modules.filter((m) => m.isGlobal).map((m) => m.name);
  if (globals.length > 0) {
    factors.push({
      label: '@Global() modules',
      penalty: Math.min(9, globals.length * 3),
      detail: `${globals.join(', ')} — global providers magnify every change's blast radius`,
    });
  }

  const score = Math.max(0, 100 - factors.reduce((sum, f) => sum + f.penalty, 0));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  return { score, grade, factors };
}
