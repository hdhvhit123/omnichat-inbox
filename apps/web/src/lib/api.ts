export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, any> = {}) {
    super(message);
  }
}

let workspaceId: string | null = null;
export function setWorkspaceId(id: string | null) {
  workspaceId = id;
}
export function getWorkspaceId() {
  return workspaceId;
}

type Opts = { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'include', signal: opts.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Không kết nối được máy chủ. Kiểm tra mạng và thử lại.');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      window.location.href = '/login';
    }
    const { code, message, ...extra } = data ?? {};
    throw new ApiError(res.status, code ?? `HTTP_${res.status}`, message ?? 'Có lỗi xảy ra', extra);
  }
  return data as T;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Tải tệp có xác thực (CSV xuất dữ liệu). */
export async function download(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: workspaceId ? { 'x-workspace-id': workspaceId } : {}, credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD', 'Không tải được tệp');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
