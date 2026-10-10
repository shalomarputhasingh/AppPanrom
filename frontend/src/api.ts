import type { Build, CompileResult, Project, Spec, SystemStatus } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the AppPanrom backend. Is it running on port 8000?');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export const api = {
  health: () => req<{ status: string }>('GET', '/health'),
  status: () => req<SystemStatus>('GET', '/api/system/status'),
  spec: () => req<Spec>('GET', '/api/language/spec'),
  projects: () => req<{ projects: Project[] }>('GET', '/api/projects').then((r) => r.projects),
  project: (id: string) => req<Project>('GET', `/api/projects/${id}`),
  createProject: (name: string) => req<Project>('POST', '/api/projects', { name }),
  patchProject: (id: string, patch: Partial<Pick<Project, 'name' | 'app_id' | 'version' | 'theme'>>) =>
    req<Project>('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id: string) => req<void>('DELETE', `/api/projects/${id}`),
  readFile: (id: string, name: string) =>
    req<{ content: string }>('GET', `/api/projects/${id}/files/${encodeURIComponent(name)}`).then((r) => r.content),
  writeFile: (id: string, name: string, content: string) =>
    req<{ size: number }>('PUT', `/api/projects/${id}/files/${encodeURIComponent(name)}`, { content }),
  deleteFile: (id: string, name: string) => req<void>('DELETE', `/api/projects/${id}/files/${encodeURIComponent(name)}`),
  validate: (id: string, source: string) => req<CompileResult>('POST', `/api/projects/${id}/validate`, { source }),
  preview: (id: string, source: string) => req<CompileResult>('POST', `/api/projects/${id}/preview`, { source }),
  startBuild: (id: string) => req<Build>('POST', `/api/projects/${id}/builds`),
  builds: (id: string) => req<{ builds: Build[] }>('GET', `/api/projects/${id}/builds`).then((r) => r.builds),
  build: (id: string) => req<Build>('GET', `/api/builds/${id}`),
  buildLog: (id: string, offset: number) =>
    req<{ text: string; next_offset: number; done: boolean }>('GET', `/api/builds/${id}/logs?offset=${offset}`),
  artifactUrl: (id: string) => `/api/builds/${id}/artifact`,
};
