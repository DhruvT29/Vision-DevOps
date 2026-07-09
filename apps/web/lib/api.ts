import type {
  CollectionsPayload,
  CollectionSummary,
  EnvironmentSummary,
  ExecutionSummary,
  GithubPreflightRequest,
  GithubPreflightResult,
  GraphPayload,
  OpenGithubRequest,
  OpenProjectResponse,
  ProjectSummary,
  RunRequest,
  RunResult,
  RunSavedRequestResult,
  SavedRequestSummary,
  ScenarioRunResult,
  ScenarioStepSummary,
  ScenarioSummary,
  SnapshotSummary,
  UpsertEnvironmentRequest,
  UpsertSavedRequest,
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
  latestSnapshot: (projectId: string) =>
    req<SnapshotSummary>(`/projects/${projectId}/latest-snapshot`),
  snapshot: (id: string) => req<SnapshotSummary>(`/snapshots/${id}`),
  graph: (id: string) => req<GraphPayload>(`/snapshots/${id}/graph`),

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

/** Cross-component refresh signal (e.g. TestPane saved a request → sidebar reloads). */
export function emitCollectionsChanged() {
  window.dispatchEvent(new Event('vision:collections-changed'));
}
export function onCollectionsChanged(handler: () => void): () => void {
  window.addEventListener('vision:collections-changed', handler);
  return () => window.removeEventListener('vision:collections-changed', handler);
}
