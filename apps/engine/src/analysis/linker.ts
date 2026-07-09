import type { HttpMethod } from '@vision/shared';

export interface LinkableEndpoint {
  id: string;
  method: string;
  fullPath: string; // "/api/addresses/:id/set-primary"
}

export interface LinkableCall {
  id: string;
  method: string; // may be UNKNOWN
  resolvedPath: string | null; // "/api/addresses/{}/set-primary"
}

export interface CallEdge {
  sourceId: string; // frontend call
  targetId: string; // endpoint
  confidence: number;
}

function segmentsOf(p: string): string[] {
  return p
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') || s === '{}' ? '*' : s.toLowerCase()));
}

function methodsMatch(a: string, b: string): boolean {
  if (a === 'UNKNOWN' || a === 'ALL' || b === 'ALL') return true;
  return a === b;
}

/**
 * Heuristic cross-layer matching: same segment count, each segment equal or
 * wildcard on either side. Confidence drops slightly per wildcard pairing and
 * sharply when a call matches several endpoints.
 */
export function linkCallsToEndpoints(
  calls: LinkableCall[],
  endpoints: LinkableEndpoint[],
): CallEdge[] {
  const prepared = endpoints.map((e) => ({ ...e, segments: segmentsOf(e.fullPath) }));
  const edges: CallEdge[] = [];

  for (const call of calls) {
    if (!call.resolvedPath) continue;
    const callSegments = segmentsOf(call.resolvedPath);

    const candidates: { endpoint: (typeof prepared)[number]; wildcards: number }[] = [];
    for (const endpoint of prepared) {
      if (!methodsMatch(call.method as HttpMethod, endpoint.method)) continue;
      if (endpoint.segments.length !== callSegments.length) continue;

      let wildcards = 0;
      let ok = true;
      for (let i = 0; i < callSegments.length; i++) {
        const a = callSegments[i];
        const b = endpoint.segments[i];
        if (a === '*' || b === '*') {
          wildcards++;
          continue;
        }
        if (a !== b) {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push({ endpoint, wildcards });
    }

    if (candidates.length === 0) continue;
    // prefer matches with the fewest wildcard pairings
    const minWildcards = Math.min(...candidates.map((c) => c.wildcards));
    const best = candidates.filter((c) => c.wildcards === minWildcards);
    const ambiguityPenalty = best.length > 1 ? 0.5 : 1;

    for (const { endpoint, wildcards } of best) {
      edges.push({
        sourceId: call.id,
        targetId: endpoint.id,
        confidence: Math.max(0.3, (1 - wildcards * 0.05) * ambiguityPenalty),
      });
    }
  }

  return edges;
}
