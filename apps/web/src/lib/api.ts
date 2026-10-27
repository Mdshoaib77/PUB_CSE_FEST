import type { ApiEnvelope } from '@festhub/shared';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api/v1';
let accessToken: string | null = null;
export const setToken = (t: string | null) => {
  accessToken = t;
};
export const getToken = () => accessToken;

/** Uploaded covers are stored by the API as "/uploads/…"; in a split deployment they must be loaded from the API origin. */
export const assetUrl = (u?: string | null) => {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `${(import.meta.env.VITE_ASSET_BASE_URL as string | undefined) ?? ''}${u}`;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return false;
      const j = (await r.json()) as ApiEnvelope<{ accessToken: string }>;
      accessToken = j.data!.accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export const refreshSession = () => refresh();

export async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/') && (await refresh())) return request<T>(method, path, body, false);
  let json: ApiEnvelope<T> | null = null;
  try {
    json = (await res.json()) as ApiEnvelope<T>;
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !json?.success) {
    const e = json?.error;
    const details = Array.isArray(e?.details)
      ? ` (${(e!.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`).join('; ')})`
      : '';
    throw new ApiError(res.status, e?.code ?? 'ERROR', (e?.message ?? `Request failed (${res.status})`) + details, e?.details);
  }
  return json.data as T;
}
export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T>(p: string) => request<T>('DELETE', p),
};
/** Authenticated request that returns a binary body (e.g. a PDF preview). Retries once after a silent refresh; errors carry the API message. */
export async function requestBlob(method: string, path: string, body?: unknown, retry = true): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && (await refresh())) return requestBlob(method, path, body, false);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const e = ((await res.json()) as ApiEnvelope<unknown>).error;
      const d = Array.isArray(e?.details) ? ` (${(e!.details as { path: string; message: string }[]).map((x) => x.message).join('; ')})` : '';
      msg = (e?.message ?? msg) + d;
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, 'REQUEST', msg);
  }
  return res.blob();
}
/** Authenticated file download (e.g. CSV export): fetches with the bearer token, then saves the blob. Retries once after a silent refresh. */
export async function download(path: string, fallbackName: string, retry = true): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (res.status === 401 && retry && (await refresh())) return download(path, fallbackName, false);
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      msg = ((await res.json()) as ApiEnvelope<unknown>).error?.message ?? msg;
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, 'DOWNLOAD', msg);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** multipart upload with real progress (fetch cannot report upload progress). Retries once after a silent token refresh. */
export function uploadFile<T>(path: string, file: File, onProgress?: (pct: number) => void, retry = true): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    xhr.withCredentials = true;
    if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error while uploading. Check your connection and try again.'));
    xhr.onload = async () => {
      if (xhr.status === 401 && retry && (await refresh())) return uploadFile<T>(path, file, onProgress, false).then(resolve, reject);
      let json: ApiEnvelope<T> | null = null;
      try {
        json = JSON.parse(xhr.responseText) as ApiEnvelope<T>;
      } catch {
        /* non-JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.success) return resolve(json.data as T);
      reject(new ApiError(xhr.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `Upload failed (${xhr.status})`));
    };
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}
