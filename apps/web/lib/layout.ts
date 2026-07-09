import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import { ENDPOINT_NODE_SIZE, MODULE_NODE_SIZE } from '@/components/graph-nodes';

/** Left-to-right dagre layout: modules rank 0, expanded endpoints rank 1. */
export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 120, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    const size = node.type === 'module' ? MODULE_NODE_SIZE : ENDPOINT_NODE_SIZE;
    g.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of edges) g.setEdge(edge.source, edge.target);

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const size = node.type === 'module' ? MODULE_NODE_SIZE : ENDPOINT_NODE_SIZE;
    return {
      ...node,
      position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
    };
  });
}
