/**
 * API 客户端封装（06 T16 / 04 §6.2）：
 * - 统一响应解包 {success, data, error}（05 §1.2）
 * - Bearer token 注入（localStorage 持久）
 * - 401 → 清除令牌并广播 `fam:unauthorized`（Auth 层登出跳转；登录/初始化/登出端点除外，防回环）
 * - 403 → 由调用方经 useToast 展示拒绝提示（此处仅抛出带角色的错误）
 * - 错误码语义见 05 §1.3
 */

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: ApiErrorDetail[];

  constructor(code: string, message: string, status: number, details?: ApiErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const TOKEN_KEY = 'fam-asset-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 401 广播事件名（Auth 适配层监听后登出） */
export const UNAUTHORIZED_EVENT = 'fam:unauthorized';

/** 这些端点的 401 不触发全局登出广播（避免登录流程内回环） */
const NO_BROADCAST_PATHS = ['/api/auth/login', '/api/auth/init', '/api/auth/logout'];

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** 携带认证头（缺省 true；init/login 无需但无害） */
  auth?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: ApiOptions['query']): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

async function handleResponse<T>(res: Response, path: string): Promise<T> {
  if (res.status === 401 && !NO_BROADCAST_PATHS.includes(path)) {
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  type Envelope = { success: boolean; data: T | null; error: { code: string; message: string; details?: ApiErrorDetail[] } | null };
  let json: Envelope | null = null;
  try {
    json = (await res.json()) as Envelope;
  } catch {
    // 非 JSON 响应（不应出现；备份下载走 apiBlob）
  }
  if (!res.ok || !json || json.success === false) {
    const err = json?.error;
    throw new ApiError(err?.code ?? 'INTERNAL_ERROR', err?.message ?? `请求失败（HTTP ${res.status}）`, res.status, err?.details);
  }
  return json.data as T;
}

/** 通用 JSON 请求（解包 data） */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, query, auth = true, signal } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return handleResponse<T>(res, path);
}

/** 文件流下载（备份导出，05 §3.26：统一响应结构的唯一例外） */
export async function apiBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { headers });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    let message = `下载失败（HTTP ${res.status}）`;
    let code = 'INTERNAL_ERROR';
    try {
      const json = (await res.json()) as { error?: { code?: string; message?: string } };
      if (json?.error?.message) message = json.error.message;
      if (json?.error?.code) code = json.error.code;
    } catch {
      /* 保持默认消息 */
    }
    throw new ApiError(code, message, res.status);
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  return { blob: await res.blob(), filename: m?.[1] ?? 'download.json' };
}
