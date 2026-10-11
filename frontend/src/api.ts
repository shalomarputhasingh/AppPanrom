import type { AiReply, AiRequest, AiStatus, Build, BuildKind, CompileResult, DesignNodeInfo, Project, Spec, SystemStatus, AppInfo } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ApiError(0, 'aborted', 'Cancelled.');
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
  designEdit: (id: string, source: string, op: Record<string, unknown>) =>
    req<{ source: string; line: number | null }>('POST', `/api/projects/${id}/design/edit`, { source, op }),
  designNode: (id: string, source: string, line: number) =>
    req<DesignNodeInfo>('POST', `/api/projects/${id}/design/node`, { source, line }),
  designApp: (id: string, source: string) => req<AppInfo>('POST', `/api/projects/${id}/design/app`, { source }),
  convert: (source: string, to: 'tanglish' | 'english') => req<{ source: string; style: string }>('POST', '/api/language/convert', { source, to }),
  aiStatus: () => req<AiStatus>('GET', '/api/ai/status'),
  aiSetKey: (key: string) => req<AiStatus>('POST', '/api/ai/key', { key }),
  aiClearKey: () => req<AiStatus>('DELETE', '/api/ai/key'),
  aiChat: (id: string, body: AiRequest, signal?: AbortSignal) => req<AiReply>('POST', `/api/projects/${id}/ai/chat`, body, signal),
  startBuild: (id: string, kind: BuildKind) => req<Build>('POST', `/api/projects/${id}/builds`, { kind }),
  iconUrl: (id: string) => `/api/projects/${id}/icon`,
  uploadIcon: async (id: string, file: File) => {
    let res: Response;
    try {
      res = await fetch(`/api/projects/${id}/icon`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: file });
    } catch {
      throw new ApiError(0, 'network', 'Cannot reach the AppPanrom backend.');
    }
    if (!res.ok) {
      const e = (await res.json().catch(() => null))?.error;
      throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Upload failed (${res.status})`);
    }
  },
  deleteIcon: (id: string) => req<void>('DELETE', `/api/projects/${id}/icon`),
  builds: (id: string) => req<{ builds: Build[] }>('GET', `/api/projects/${id}/builds`).then((r) => r.builds),
  build: (id: string) => req<Build>('GET', `/api/builds/${id}`),
  buildLog: (id: string, offset: number) =>
    req<{ text: string; next_offset: number; done: boolean }>('GET', `/api/builds/${id}/logs?offset=${offset}`),
  artifactUrl: (id: string) => `/api/builds/${id}/artifact`,
};
