import type { Edge, Node } from '@xyflow/react';
import { MODULE_NODE_SIZE } from '@/components/graph-nodes';

const NODE_W = MODULE_NODE_SIZE.width;
const NODE_H = MODULE_NODE_SIZE.height;
const GAP_X = 70;
const GAP_Y = 50;
const IDEAL = 230; // spring rest length in simulation space
const ITERATIONS = 400;
const STRETCH_X = 1.9; // widen the result — cards are ~4x wider than tall

/**
 * Deterministic force-directed layout (Fruchterman–Reingold flavored) for the
 * module dependency graph. Unlike dagre's rank bands this spreads modules
 * radially, so dependency lines fan out in every direction instead of
 * bundling into a left-to-right pipeline. A final pass separates any cards
 * that still overlap. Deterministic: same input always yields the same
 * positions (no random seed), so re-renders don't shuffle the graph.
 */
export function layoutDependencyGraph(nodes: Node[], edges: Edge[]): Node[] {
  const n = nodes.length;
  if (n === 0) return nodes;

  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);

  // deterministic seed: golden-angle spiral
  for (let i = 0; i < n; i++) {
    const angle = i * 2.39996323;
    const radius = 80 * Math.sqrt(i + 0.5);
    xs[i] = Math.cos(angle) * radius;
    ys[i] = Math.sin(angle) * radius;
  }

  // one spring per connected pair (mutual imports collapse into one)
  const links: [number, number][] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const key = s < t ? `${s}|${t}` : `${t}|${s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([s, t]);
  }

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const temp = 60 * (1 - iter / ITERATIONS) + 2; // cooling max step
    fx.fill(0);
    fy.fill(0);

    // pairwise repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[i] - xs[j];
        const dy = ys[i] - ys[j];
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const f = (IDEAL * IDEAL) / d;
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f;
        fy[i] += uy * f;
        fx[j] -= ux * f;
        fy[j] -= uy * f;
      }
    }

    // spring attraction along dependencies
    for (const [s, t] of links) {
      const dx = xs[s] - xs[t];
      const dy = ys[s] - ys[t];
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d * d) / IDEAL;
      const ux = dx / d;
      const uy = dy / d;
      fx[s] -= ux * f;
      fy[s] -= uy * f;
      fx[t] += ux * f;
      fy[t] += uy * f;
    }

    // light gravity keeps disconnected modules near the component
    for (let i = 0; i < n; i++) {
      fx[i] -= xs[i] * 0.03;
      fy[i] -= ys[i] * 0.03;
    }

    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]);
      if (d < 1e-9) continue;
      const step = Math.min(d, temp);
      xs[i] += (fx[i] / d) * step;
      ys[i] += (fy[i] / d) * step;
    }
  }

  // stretch horizontally to account for the cards' landscape aspect
  for (let i = 0; i < n; i++) xs[i] *= STRETCH_X;

  // separate any cards that still overlap (axis of least penetration)
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ox = NODE_W + GAP_X - Math.abs(xs[i] - xs[j]);
        const oy = NODE_H + GAP_Y - Math.abs(ys[i] - ys[j]);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const push = ox / 2 + 1;
          const dir = xs[i] < xs[j] ? -1 : 1;
          xs[i] += dir * push;
          xs[j] -= dir * push;
        } else {
          const push = oy / 2 + 1;
          const dir = ys[i] < ys[j] ? -1 : 1;
          ys[i] += dir * push;
          ys[j] -= dir * push;
        }
      }
    }
    if (!moved) break;
  }

  return nodes.map((node, i) => ({
    ...node,
    position: { x: xs[i] - NODE_W / 2, y: ys[i] - NODE_H / 2 },
  }));
}
