import type { AssertionResult, AssertionSpec, RunResult } from '@vision/shared';

/**
 * Resolve a dot path like "data.items[0].id" into a parsed JSON value.
 * Returns undefined when any segment is missing.
 */
export function resolveJsonPath(root: unknown, pathExpr: string): unknown {
  const tokens = pathExpr.match(/[^.[\]]+/g) ?? [];
  let current: unknown = root;
  for (const token of tokens) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function asComparable(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function compare(operator: AssertionSpec['operator'], actual: string | null, expected?: string): boolean {
  switch (operator) {
    case 'exists':
      return actual !== null;
    case 'eq': {
      if (actual === null) return false;
      const a = Number(actual);
      const e = Number(expected);
      if (!Number.isNaN(a) && !Number.isNaN(e) && expected !== '' && actual !== '') return a === e;
      return actual === (expected ?? '');
    }
    case 'neq':
      return actual !== (expected ?? '');
    case 'lt':
      return actual !== null && Number(actual) < Number(expected);
    case 'gt':
      return actual !== null && Number(actual) > Number(expected);
    case 'contains':
      return actual !== null && actual.includes(expected ?? '');
    default:
      return false;
  }
}

export function evaluateAssertions(specs: AssertionSpec[], result: RunResult): AssertionResult[] {
  let parsedBody: unknown;
  let bodyParsed = false;

  return specs.map((spec) => {
    let actual: string | null = null;

    switch (spec.type) {
      case 'status':
        actual = result.status != null ? String(result.status) : null;
        break;
      case 'responseTime':
        actual = String(result.durationMs);
        break;
      case 'header': {
        const name = (spec.pathExpr ?? '').toLowerCase();
        const found = Object.entries(result.responseHeaders).find(
          ([k]) => k.toLowerCase() === name,
        );
        actual = found ? found[1] : null;
        break;
      }
      case 'jsonPath': {
        if (!bodyParsed) {
          bodyParsed = true;
          try {
            parsedBody = JSON.parse(result.body);
          } catch {
            parsedBody = undefined;
          }
        }
        actual = asComparable(resolveJsonPath(parsedBody, spec.pathExpr ?? ''));
        break;
      }
    }

    return { ...spec, actual, passed: compare(spec.operator, actual, spec.expected) };
  });
}
