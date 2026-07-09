/**
 * Vision shared contract — TYPES ONLY.
 * Both apps/web and apps/engine import from here with `import type { ... }`.
 * Do not add runtime values (constants, functions, classes): the engine's tsc
 * build and Next's bundler both rely on these imports being fully erasable.
 */

// ── Projects & scanning ─────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  /** Stacks detected inside the root, e.g. ["nest", "next", "react"] */
  detectedStacks: DetectedStack[];
  lastOpenedAt: string; // ISO
  createdAt: string; // ISO
}

export interface DetectedStack {
  kind: 'nest' | 'next' | 'react' | 'unknown-node';
  /** Directory relative to project root, e.g. "backend" or "." */
  dir: string;
  /** Human hint, e.g. package.json "name" */
  label?: string;
}

export type ScanStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SnapshotSummary {
  id: string;
  projectId: string;
  status: ScanStatus;
  createdAt: string; // ISO
  error?: string;
  stats?: SnapshotStats;
}

export interface SnapshotStats {
  modules: number;
  endpoints: number;
  frontendCalls: number;
  edges: number;
  durationMs: number;
}

// ── Graph model ─────────────────────────────────────────────────────────────

export type ModuleKind = 'nest-module' | 'next-api-group' | 'react-feature';

export interface ModuleNode {
  id: string;
  snapshotId: string;
  name: string;
  kind: ModuleKind;
  /** Absolute path of the defining file (e.g. the *.module.ts) */
  filePath: string;
  endpointCount: number;
}

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'ALL';

export type EndpointLayer = 'nest' | 'next-api';

export interface EndpointParam {
  name: string;
  source: 'path' | 'query';
  type?: string;
  optional?: boolean;
}

/** Flattened JSON-schema-ish description of a request body DTO. */
export interface BodyField {
  name: string;
  type: string;
  optional: boolean;
  /** class-validator decorators seen on the field, e.g. ["IsString", "IsOptional"] */
  validators: string[];
}

export interface EndpointAuth {
  required: boolean;
  /** Guard class names, class-level + method-level merged, e.g. ["AuthGuard('jwt')", "RolesGuard"] */
  guards: string[];
  /** Roles from @Roles(...), e.g. ["ADMIN"] */
  roles: string[];
}

export interface Endpoint {
  id: string;
  moduleId: string;
  layer: EndpointLayer;
  method: HttpMethod;
  /** Full request path including any global prefix, e.g. "/api/addresses/:id" */
  fullPath: string;
  handlerName: string;
  params: EndpointParam[];
  bodyFields: BodyField[] | null;
  /** Name of the body DTO class if any, e.g. "CreateAddressDto" */
  bodyTypeName: string | null;
  auth: EndpointAuth;
  filePath: string;
  line: number;
}

export type FrontendHttpClient = 'axios' | 'fetch' | 'react-query' | 'rtk-query' | 'other';

export interface FrontendCall {
  id: string;
  snapshotId: string;
  client: FrontendHttpClient;
  method: HttpMethod | 'UNKNOWN';
  /** URL expression as written in source */
  rawUrl: string;
  /** Best-effort resolved path with dynamic parts as {} wildcards, e.g. "/api/orders/{}" */
  resolvedPath: string | null;
  callerSymbol: string;
  filePath: string;
  line: number;
}

export type EdgeType = 'contains' | 'calls' | 'imports';

export interface GraphEdge {
  id: string;
  snapshotId: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  /** 0..1 — only meaningful for heuristic `calls` edges */
  confidence: number;
  /** true when a user manually created/confirmed the edge */
  manual: boolean;
}

/** Full graph payload the engine returns for a snapshot. */
export interface GraphPayload {
  snapshot: SnapshotSummary;
  modules: ModuleNode[];
  endpoints: Endpoint[];
  frontendCalls: FrontendCall[];
  edges: GraphEdge[];
}

// ── Environments & request running ─────────────────────────────────────────

export interface EnvironmentAuth {
  type: 'none' | 'bearer';
  token?: string;
  /** Header name override; defaults to Authorization: Bearer <token> */
  header?: string;
}

export interface EnvironmentSummary {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  variables: Record<string, string>;
  auth: EnvironmentAuth;
  createdAt: string; // ISO
}

export interface UpsertEnvironmentRequest {
  name: string;
  baseUrl: string;
  variables?: Record<string, string>;
  auth?: EnvironmentAuth;
}

export interface RunRequest {
  projectId: string;
  environmentId?: string;
  /** endpoint the run originated from, for history grouping */
  endpointId?: string;
  method: HttpMethod;
  /**
   * Absolute URL (http...) used as-is, otherwise treated as a path and
   * prefixed with the environment baseUrl. May contain {{variables}}.
   */
  url: string;
  headers?: Record<string, string>;
  /** Raw body string (JSON typically); {{variables}} are interpolated */
  body?: string | null;
}

export interface RunResult {
  executionId: string;
  /** Final URL after interpolation/baseUrl resolution */
  url: string;
  status?: number;
  statusText?: string;
  durationMs: number;
  responseHeaders: Record<string, string>;
  body: string;
  truncated: boolean;
  error?: string;
}

export interface ExecutionSummary {
  id: string;
  endpointId?: string;
  environmentId?: string;
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  error?: string;
  createdAt: string; // ISO
}

// ── Collections, assertions, scenarios ──────────────────────────────────────

export type AssertionType = 'status' | 'jsonPath' | 'header' | 'responseTime';
export type AssertionOperator = 'eq' | 'neq' | 'lt' | 'gt' | 'contains' | 'exists';

export interface AssertionSpec {
  id?: string;
  type: AssertionType;
  /** dot path for jsonPath (e.g. "data.items[0].id"), header name for header */
  pathExpr?: string;
  operator: AssertionOperator;
  expected?: string;
}

export interface AssertionResult extends AssertionSpec {
  actual: string | null;
  passed: boolean;
}

export interface SavedRequestSummary {
  id: string;
  collectionId: string;
  name: string;
  endpointId?: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  assertions: AssertionSpec[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionSummary {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
}

export interface CollectionsPayload {
  collections: CollectionSummary[];
  requests: SavedRequestSummary[];
}

export interface UpsertSavedRequest {
  name: string;
  endpointId?: string;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
  assertions?: AssertionSpec[];
}

export interface RunSavedRequestResult {
  result: RunResult;
  assertions: AssertionResult[];
}

export interface VariableExtraction {
  /** runtime variable name, referenced later as {{name}} */
  name: string;
  /** dot path into the JSON response body */
  pathExpr: string;
}

export interface ScenarioStepSummary {
  id: string;
  scenarioId: string;
  savedRequestId: string;
  order: number;
  extractions: VariableExtraction[];
}

export interface ScenarioSummary {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  steps: ScenarioStepSummary[];
}

export interface StepRunResult {
  stepId: string;
  requestId: string;
  requestName: string;
  result: RunResult;
  assertions: AssertionResult[];
  extracted: Record<string, string>;
  /** true when the step was not run because a previous step failed */
  skipped: boolean;
}

export interface ScenarioRunResult {
  scenarioId: string;
  passed: boolean;
  steps: StepRunResult[];
}

// ── Engine API DTOs ─────────────────────────────────────────────────────────

export interface OpenProjectRequest {
  rootPath: string;
}

export interface OpenProjectResponse {
  project: ProjectSummary;
  snapshot: SnapshotSummary;
}

export interface HealthResponse {
  ok: boolean;
  service: 'vision-engine';
  version: string;
}
