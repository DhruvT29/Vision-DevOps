/**
 * Vision shared contract — TYPES ONLY.
 * Both apps/web and apps/engine import from here with `import type { ... }`.
 * Do not add runtime values (constants, functions, classes): the engine's tsc
 * build and Next's bundler both rely on these imports being fully erasable.
 */

// ── Projects & scanning ─────────────────────────────────────────────────────

export type ProjectSource = 'local' | 'github';

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  /** Stacks detected inside the root, e.g. ["nest", "next", "react"] */
  detectedStacks: DetectedStack[];
  /** Where the code came from — a local directory or a cloned GitHub repo */
  source: ProjectSource;
  /** Canonical https URL (github projects) — used for display + blob links */
  repoUrl?: string;
  /** Transport URL git actually cloned from (ssh or https form) */
  repoCloneUrl?: string;
  /** Branch that was cloned/analyzed */
  repoBranch?: string;
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
  /** database entities found (absent on snapshots scanned before the DB layer) */
  tables?: number;
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
  /** Nest @Global() module — its providers are reachable everywhere without imports */
  isGlobal?: boolean;
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
  /** github projects only — link to the defining line on github.com */
  sourceUrl?: string;
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
  /** github projects only — link to the call site on github.com */
  sourceUrl?: string;
}

/**
 * `imports`       — declared NestJS wiring: @Module({ imports: [...] })
 * `file-imports`  — hidden coupling: raw import statements crossing module
 *                   folders without the @Module wiring (DTOs, helpers, ...)
 * `fk`            — entity → entity foreign-key relation (@ManyToOne etc.)
 * `touches-table` — module → entity: the module reads/writes that table
 */
export type EdgeType = 'contains' | 'calls' | 'imports' | 'file-imports' | 'fk' | 'touches-table';

// ── Database entity layer ────────────────────────────────────────────────────

export interface EntityColumn {
  name: string;
  type?: string;
}

/** TypeORM @Entity class — one database table. */
export interface DbEntityNode {
  id: string;
  snapshotId: string;
  /** class name, e.g. "User" */
  name: string;
  /** resolved table name, e.g. "users" */
  tableName: string;
  filePath: string;
  line: number;
  /** owning module's row id (the module whose folder defines the entity) */
  moduleId: string | null;
  columns: EntityColumn[];
  /** github projects only — link to the defining line on github.com */
  sourceUrl?: string;
}

export type TableTouchKind = 'repository' | 'relation' | 'import' | 'raw-sql';

/** Evidence on a `touches-table` edge (module → entity). */
export interface TableTouchMeta {
  via: TableTouchKind[];
  /** sample of files where the access happens, project-root relative */
  files?: string[];
}

/** Evidence on an `fk` edge (entity → entity). */
export interface FkMeta {
  /** relation property names, e.g. ["user"] */
  properties: string[];
}

/**
 * Coupling evidence carried by dependency edges. On `file-imports` edges it
 * describes the hidden coupling itself; on declared `imports` edges it
 * describes the file-level traffic underneath the wiring (when any exists).
 * Paths are project-root relative.
 */
export interface CouplingMeta {
  /** total number of cross-module import statements found */
  count: number;
  /** sample of importing → imported file pairs (capped) */
  files: { from: string; to: string }[];
  /** symbols crossing the boundary (services, DTOs, helpers) with usage counts */
  symbols?: { name: string; count: number }[];
}

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
  /** edge-type-specific evidence — CouplingMeta on imports/file-imports, TableTouchMeta on touches-table, FkMeta on fk */
  meta?: CouplingMeta | TableTouchMeta | FkMeta;
}

// ── Insights (health / churn / ownership) & diff impact ─────────────────────

export interface ContributorStat {
  name: string;
  commits: number;
}

export interface ModuleChurn {
  moduleId: string;
  name: string;
  /** commits that touched at least one file owned by this module */
  commits: number;
  lastCommitAt?: string; // ISO
  /** top contributors for this module's files */
  contributors: ContributorStat[];
}

export interface InsightsPayload {
  snapshotId: string;
  git: {
    available: boolean;
    /** set when available=false, e.g. "not a git repository" */
    reason?: string;
    commitsAnalyzed: number;
    /** true when a shallow GitHub clone was deepened for history */
    deepened?: boolean;
  };
  /** repo-wide top contributors (within the project root) */
  contributors: ContributorStat[];
  modules: ModuleChurn[];
}

export interface DiffImpactRequest {
  /**
   * Git ref to diff the working tree against. Defaults to HEAD (uncommitted
   * changes). For GitHub-sourced projects pass a branch/ref to compare, e.g.
   * "main" or "main~5".
   */
  base?: string;
}

export interface ChangedFile {
  /** project-root-relative path */
  path: string;
  /** git status letter: M, A, D, R, ... */
  status: string;
  moduleId: string | null;
  moduleName: string | null;
}

export interface DiffImpactResult {
  /** the ref actually diffed against */
  base: string;
  changedFiles: ChangedFile[];
  /** distinct modules owning changed files */
  moduleIds: string[];
}

// ── DB blast analysis ────────────────────────────────────────────────────────

export interface DbDiffRequest {
  /** raw SQL to analyze (pasted migration) */
  sql?: string;
  /** project-root-relative path of a migration file to analyze instead */
  migrationPath?: string;
}

export interface DbDiffResult {
  /** what was analyzed: "sql" or the migration file path */
  source: string;
  /** table names found in the migration/SQL */
  tables: string[];
  /** snapshot entity ids whose tableName matched */
  matchedEntityIds: string[];
  /** table names with no matching entity in the snapshot */
  unmatched: string[];
}

/** Full graph payload the engine returns for a snapshot. */
export interface GraphPayload {
  snapshot: SnapshotSummary;
  modules: ModuleNode[];
  endpoints: Endpoint[];
  frontendCalls: FrontendCall[];
  edges: GraphEdge[];
  /** database entity layer (TypeORM @Entity classes); empty for older snapshots */
  entities: DbEntityNode[];
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

// ── GitHub source ───────────────────────────────────────────────────────────

export interface OpenGithubRequest {
  /** https or ssh github URL */
  repoUrl: string;
  /** branch to clone; defaults to the repo's default branch */
  branch?: string;
  /** optional PAT override; system credentials are tried first when omitted */
  token?: string;
}

export interface GithubPreflightRequest {
  repoUrl: string;
  token?: string;
}

/**
 * Result of the pre-open check: credential discovery + access probe + branch
 * list. Discriminated on `access`.
 */
export type GithubPreflightResult =
  | {
      access: true;
      /** github login of the account that had access, e.g. "octocat" */
      account?: string;
      /** true when access came from a discovered system credential (not public, not a pasted token) */
      usedSystemCredential: boolean;
      defaultBranch: string;
      branches: string[];
    }
  | {
      access: false;
      /** github logins whose credentials were tried, for the "ask owner" message */
      triedAccounts: string[];
    };

/** Body of the 403 the engine returns when a direct Open finds no access. */
export interface GithubNoAccessError {
  message: string;
  triedAccounts: string[];
}

export interface HealthResponse {
  ok: boolean;
  service: 'vision-engine';
  version: string;
}
