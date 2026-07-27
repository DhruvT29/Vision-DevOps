import type {
  CollectionsPayload,
  CollectionSummary,
  DbConnectionConfig,
  DbConnectionInfo,
  DbDiffRequest,
  DbDiffResult,
  DbSchemaResult,
  DeploymentDetail,
  DeploymentSummary,
  DeployTargetSummary,
  DiffImpactResult,
  EnvironmentSummary,
  ExecutionSummary,
  GithubPreflightRequest,
  GithubPreflightResult,
  GraphPayload,
  InsightsPayload,
  OpenGithubRequest,
  OpenProjectResponse,
  ParsedDeployScript,
  ParseScriptRequest,
  ProjectBranchesResult,
  ProjectSummary,
  RunRequest,
  RunResult,
  RunSavedRequestResult,
  SavedRequestSummary,
  ScenarioRunResult,
  ScenarioStepSummary,
  ScenarioSummary,
  ServerSummary,
  ServerTestResult,
  SnapshotSummary,
  StartDeployResult,
  UpsertDeployTargetRequest,
  UpsertEnvironmentRequest,
  UpsertSavedRequest,
  UpsertServerRequest,
  VariableExtraction,
} from '@vision/shared';

const ENGINE = process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ENGINE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Like `req` but tolerates an empty 200 body (endpoint may return null). */
async function reqNullable<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`${ENGINE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

export const api = {
  openProject: (rootPath: string) =>
    req<OpenProjectResponse>('/projects/open', {
      method: 'POST',
      body: JSON.stringify({ rootPath }),
    }),
  openGithub: (body: OpenGithubRequest) =>
    req<OpenProjectResponse>('/projects/open-github', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  githubPreflight: (body: GithubPreflightRequest) =>
    req<GithubPreflightResult>('/projects/github-preflight', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listProjects: () => req<ProjectSummary[]>('/projects'),
  deleteProject: (id: string) =>
    req<{ ok: true }>(`/projects/${id}`, { method: 'DELETE' }),
  latestSnapshot: (projectId: string) =>
    req<SnapshotSummary>(`/projects/${projectId}/latest-snapshot`),
  projectBranches: (projectId: string) =>
    req<ProjectBranchesResult>(`/projects/${projectId}/branches`),
  snapshot: (id: string) => req<SnapshotSummary>(`/snapshots/${id}`),
  graph: (id: string) => req<GraphPayload>(`/snapshots/${id}/graph`),
  insights: (id: string) => req<InsightsPayload>(`/snapshots/${id}/insights`),
  migrationFiles: (id: string) => req<string[]>(`/snapshots/${id}/migration-files`),
  dbDiff: (id: string, body: DbDiffRequest) =>
    req<DbDiffResult>(`/snapshots/${id}/db-diff`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  diffImpact: (id: string, base?: string) =>
    req<DiffImpactResult>(`/snapshots/${id}/diff-impact`, {
      method: 'POST',
      body: JSON.stringify({ base: base || undefined }),
    }),

  listEnvironments: (projectId: string) =>
    req<EnvironmentSummary[]>(`/projects/${projectId}/environments`),
  createEnvironment: (projectId: string, body: UpsertEnvironmentRequest) =>
    req<EnvironmentSummary>(`/projects/${projectId}/environments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateEnvironment: (id: string, body: UpsertEnvironmentRequest) =>
    req<EnvironmentSummary>(`/environments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  run: (body: RunRequest) =>
    req<RunResult>('/run', { method: 'POST', body: JSON.stringify(body) }),
  executions: (projectId: string, endpointId?: string) =>
    req<ExecutionSummary[]>(
      `/projects/${projectId}/executions${endpointId ? `?endpointId=${endpointId}` : ''}`,
    ),

  collections: (projectId: string) =>
    req<CollectionsPayload>(`/projects/${projectId}/collections`),
  createCollection: (projectId: string, name: string, parentId?: string) =>
    req<CollectionSummary>(`/projects/${projectId}/collections`, {
      method: 'POST',
      body: JSON.stringify({ name, parentId }),
    }),
  deleteCollection: (id: string) =>
    req<void>(`/collections/${id}`, { method: 'DELETE' }),
  createRequest: (collectionId: string, body: UpsertSavedRequest) =>
    req<SavedRequestSummary>(`/collections/${collectionId}/requests`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateRequest: (id: string, body: UpsertSavedRequest) =>
    req<SavedRequestSummary>(`/requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteRequest: (id: string) => req<void>(`/requests/${id}`, { method: 'DELETE' }),
  runSavedRequest: (id: string, environmentId?: string) =>
    req<RunSavedRequestResult>(`/requests/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ environmentId }),
    }),

  // ── Deployment ─────────────────────────────────────────────────────────────
  servers: () => req<ServerSummary[]>('/servers'),
  createServer: (body: UpsertServerRequest) =>
    req<ServerSummary>('/servers', { method: 'POST', body: JSON.stringify(body) }),
  updateServer: (id: string, body: UpsertServerRequest) =>
    req<ServerSummary>(`/servers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteServer: (id: string) =>
    req<{ ok: true }>(`/servers/${id}`, { method: 'DELETE' }),
  testServer: (id: string) =>
    req<ServerTestResult>(`/servers/${id}/test`, { method: 'POST' }),

  deployTargets: (projectId: string) =>
    req<DeployTargetSummary[]>(`/projects/${projectId}/deploy-targets`),
  createDeployTarget: (projectId: string, body: UpsertDeployTargetRequest) =>
    req<DeployTargetSummary>(`/projects/${projectId}/deploy-targets`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateDeployTarget: (id: string, body: UpsertDeployTargetRequest) =>
    req<DeployTargetSummary>(`/deploy-targets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteDeployTarget: (id: string) =>
    req<{ ok: true }>(`/deploy-targets/${id}`, { method: 'DELETE' }),

  startDeploy: (targetId: string) =>
    req<StartDeployResult>(`/deploy-targets/${targetId}/deploy`, { method: 'POST' }),
  deployment: (id: string) => req<DeploymentDetail>(`/deployments/${id}`),
  deployments: (projectId: string, limit = 20) =>
    req<DeploymentSummary[]>(`/projects/${projectId}/deployments?limit=${limit}`),
  cancelDeployment: (id: string) =>
    req<{ ok: true }>(`/deployments/${id}/cancel`, { method: 'POST' }),
  respondDeployment: (id: string, stepIndex: number, answer: boolean) =>
    req<{ ok: true }>(`/deployments/${id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ stepIndex, answer }),
    }),
  parseDeployScript: (body: ParseScriptRequest) =>
    req<ParsedDeployScript>('/deploy/parse-script', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── Database schema ──────────────────────────────────────────────────────────
  dbConnection: (targetId: string) =>
    req<DbConnectionInfo>(`/deploy-targets/${targetId}/db-connection`),
  saveDbConnection: (targetId: string, body: DbConnectionConfig) =>
    req<DbConnectionInfo>(`/deploy-targets/${targetId}/db-connection`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  dbSchema: (targetId: string) =>
    reqNullable<DbSchemaResult>(`/deploy-targets/${targetId}/db-schema`),
  fetchDbSchema: (targetId: string) =>
    req<DbSchemaResult>(`/deploy-targets/${targetId}/db-schema/fetch`, { method: 'POST' }),

  scenarios: (projectId: string) => req<ScenarioSummary[]>(`/projects/${projectId}/scenarios`),
  createScenario: (projectId: string, name: string) =>
    req<ScenarioSummary>(`/projects/${projectId}/scenarios`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  deleteScenario: (id: string) => req<void>(`/scenarios/${id}`, { method: 'DELETE' }),
  addScenarioStep: (
    scenarioId: string,
    savedRequestId: string,
    extractions: VariableExtraction[],
  ) =>
    req<ScenarioStepSummary>(`/scenarios/${scenarioId}/steps`, {
      method: 'POST',
      body: JSON.stringify({ savedRequestId, extractions }),
    }),
  deleteScenarioStep: (id: string) =>
    req<void>(`/scenario-steps/${id}`, { method: 'DELETE' }),
  runScenario: (id: string, environmentId?: string) =>
    req<ScenarioRunResult>(`/scenarios/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ environmentId }),
    }),
};

/**
 * Live deployment log stream. Uses EventSource directly (the JSON `req` helper
 * can't stream). Returns an unsubscribe function. `onEvent` fires per SSE
 * message; `onError` fires if the connection drops before `done`.
 */
export function streamDeployment(
  id: string,
  onEvent: (ev: import('@vision/shared').DeployEvent) => void,
  onError?: () => void,
): () => void {
  const es = new EventSource(`${ENGINE}/deployments/${id}/stream`);
  es.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as import('@vision/shared').DeployEvent;
      onEvent(ev);
      if (ev.type === 'done') es.close();
    } catch {
      /* ignore malformed frame */
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects; if the run is already done the stream closed
    // cleanly and this won't fire. Surface transient drops to the caller.
    if (es.readyState === EventSource.CLOSED) onError?.();
  };
  return () => es.close();
}

/** Cross-component refresh signal (e.g. TestPane saved a request → sidebar reloads). */
export function emitCollectionsChanged() {
  window.dispatchEvent(new Event('vision:collections-changed'));
}
export function onCollectionsChanged(handler: () => void): () => void {
  window.addEventListener('vision:collections-changed', handler);
  return () => window.removeEventListener('vision:collections-changed', handler);
}
