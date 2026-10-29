import { config } from '../config';

/**
 * Kết quả gọi HTTP tới nền tảng, phân loại để quyết định retry:
 * - network_before_send: chưa gửi được request (DNS, từ chối kết nối) → an toàn để thử lại
 * - timeout: request có thể đã tới nền tảng → KHÔNG thử lại mù
 */
export type HttpResult =
  | { kind: 'response'; status: number; body: any; headers: Headers }
  | { kind: 'timeout' }
  | { kind: 'network_before_send'; error: string }
  | { kind: 'network_unknown'; error: string };

const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export async function platformFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? config().PLATFORM_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* giữ nguyên chuỗi */
    }
    return { kind: 'response', status: res.status, body, headers: res.headers };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { kind: 'timeout' };
    const code = e?.cause?.code ?? e?.code;
    if (code && PRE_SEND_CODES.has(code)) return { kind: 'network_before_send', error: String(code) };
    return { kind: 'network_unknown', error: String(code ?? e?.message ?? 'unknown') };
  } finally {
    clearTimeout(timer);
  }
}

/** Ẩn token trong URL trước khi ghi log/lỗi. */
export function redactUrl(url: string): string {
  return url.replace(/(access_token|client_secret|fb_exchange_token|appsecret_proof)=[^&]+/g, '$1=***');
}
