import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import { ENDPOINT_NODE_SIZE, MODULE_NODE_SIZE } from '@/components/graph-nodes';

const GRID_GAP_X = 32;
const GRID_GAP_Y = 24;
const BLOCK_GAP = 200;

type Positioned = { node: Node; x: number; y: number };
type Block = { items: Positioned[]; width: number; height: number };

const EMPTY_BLOCK: Block = { items: [], width: 0, height: 0 };

function sizeOf(node: Node) {
  return node.type === 'module' ? MODULE_NODE_SIZE : ENDPOINT_NODE_SIZE;
}

/** Collapsed (edge-less) module cards arranged in a roughly screen-shaped grid. */
function gridBlock(nodes: Node[]): Block {
  if (nodes.length === 0) return EMPTY_BLOCK;
  const cellW = MODULE_NODE_SIZE.width + GRID_GAP_X;
  const cellH = MODULE_NODE_SIZE.height + GRID_GAP_Y;
  // pick a column count that makes the block roughly 16:9
  const cols = Math.max(1, Math.round(Math.sqrt((nodes.length * (16 / 9) * cellH) / cellW)));
  const rows = Math.ceil(nodes.length / cols);
  const items = nodes.map((node, i) => ({
    node,
    x: (i % cols) * cellW,
    y: Math.floor(i / cols) * cellH,
  }));
  return { items, width: cols * cellW - GRID_GAP_X, height: rows * cellH - GRID_GAP_Y };
}

/** Left-to-right dagre layout for everything that participates in an edge. */
function flowBlock(nodes: Node[], edges: Edge[]): Block {
  if (nodes.length === 0) return EMPTY_BLOCK;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    const size = sizeOf(node);
    g.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const items = nodes.map((node) => {
    const pos = g.node(node.id);
    const size = sizeOf(node);
    const x = pos.x - size.width / 2;
    const y = pos.y - size.height / 2;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + size.width);
    maxY = Math.max(maxY, y + size.height);
    return { node, x, y };
  });
  for (const item of items) {
    item.x -= minX;
    item.y -= minY;
  }
  return { items, width: maxX - minX, height: maxY - minY };
}

/**
 * Hybrid layout. Nodes touched by an edge (expanded modules, their endpoints,
 * call flows) get a left-to-right dagre layout; edge-less module cards are
 * arranged in grids instead of dagre's single-rank column. Bands run left to
 * right — collapsed frontend features, the wired flow, collapsed backend
 * modules — matching the frontend→backend direction of the calls edges.
 */
export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }

  const isFrontend = (n: Node) =>
    (n.data as { module?: { kind?: string } })?.module?.kind === 'react-feature';

  const wired = nodes.filter((n) => connected.has(n.id));
  const idle = nodes.filter((n) => !connected.has(n.id));

  const blocks = [
    gridBlock(idle.filter(isFrontend)),
    flowBlock(wired, edges),
    gridBlock(idle.filter((n) => !isFrontend(n))),
  ].filter((b) => b.items.length > 0);

  const maxHeight = Math.max(0, ...blocks.map((b) => b.height));
  const out: Node[] = [];
  let offsetX = 0;
  for (const block of blocks) {
    const offsetY = (maxHeight - block.height) / 2;
    for (const { node, x, y } of block.items) {
      out.push({ ...node, position: { x: x + offsetX, y: y + offsetY } });
    }
    offsetX += block.width + BLOCK_GAP;
  }
  return out;
}
