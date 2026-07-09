import type {
  EnvironmentSummary,
  ExecutionSummary,
  GraphPayload,
  OpenProjectResponse,
  ProjectSummary,
  RunRequest,
  RunResult,
  SnapshotSummary,
  UpsertEnvironmentRequest,
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
};
