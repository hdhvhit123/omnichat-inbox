import { Injectable } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { config } from '../../config';
import { platformFetch } from '../../common/http';
import { ChannelAdapter, OutgoingMessage, SendOutcome, VerifyOutcome } from './types';

/**
 * Zalo OA Open API — tin tư vấn: POST https://openapi.zalo.me/v3.0/oa/message/cs (header access_token)
 * Xem docs/PLATFORM_SOURCES.md: endpoint đối chiếu từ SDK/nguồn phụ, CẦN xác minh với tài liệu chính thức.
 */
@Injectable()
export class ZaloAdapter implements ChannelAdapter {
  readonly kind = 'zalo' as const;

  async send(channel: Channel, token: string, msg: OutgoingMessage): Promise<SendOutcome> {
    if (channel.isSimulated) throw new Error('Adapter thật không được dùng cho kênh mô phỏng');
    let message: Record<string, unknown>;
    if (msg.attachment?.type === 'image') {
      message = {
        text: msg.text ?? undefined,
        attachment: { type: 'template', payload: { template_type: 'media', elements: [{ media_type: 'image', url: msg.attachment.url }] } },
      };
    } else if (msg.attachment) {
      const up = await this.uploadFile(token, msg.attachment.name, msg.attachment.mime, msg.attachment.data);
      if (up.outcome !== 'accepted') return up;
      message = { attachment: { type: 'file', payload: { token: up.externalId } } };
    } else {
      message = { text: msg.text ?? '' };
    }
    const r = await platformFetch(`${config().ZALO_OPENAPI_BASE}/v3.0/oa/message/cs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: token },
      body: JSON.stringify({ recipient: { user_id: msg.recipientId }, message }),
    });
    return mapZaloResult(r);
  }

  private async uploadFile(token: string, name: string, mime: string, data?: () => Promise<Buffer>): Promise<SendOutcome> {
    if (!data) return { outcome: 'failed', retryable: false, code: 'NO_DATA', message: 'Thiếu dữ liệu tệp' };
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await data())], { type: mime }), name);
    const r = await platformFetch(`${config().ZALO_OPENAPI_BASE}/v2.0/oa/upload/file`, { method: 'POST', headers: { access_token: token }, body: form });
    if (r.kind === 'response' && r.body?.error === 0 && r.body?.data?.token) return { outcome: 'accepted', externalId: r.body.data.token };
    // Upload thất bại thì tin chưa được gửi → có thể thử lại an toàn
    const m = mapZaloResult(r);
    return m.outcome === 'unknown' ? { outcome: 'failed', retryable: true, code: 'ZALO_UPLOAD', message: m.message } : m;
  }

  async verify(_channel: Channel, token: string): Promise<VerifyOutcome> {
    const r = await platformFetch(`${config().ZALO_OPENAPI_BASE}/v2.0/oa/getoa`, { headers: { access_token: token } });
    if (r.kind !== 'response') return { ok: false, code: r.kind.toUpperCase(), message: 'Không kết nối được tới Zalo Open API' };
    if (r.body?.error !== 0) {
      return { ok: false, code: `ZALO_${r.body?.error ?? r.status}`, message: r.body?.message ?? 'Lỗi Zalo API', authError: ZALO_AUTH_ERRORS.has(Number(r.body?.error)) };
    }
    const d = r.body.data ?? {};
    return { ok: true, externalId: String(d.oa_id), name: d.name, avatarUrl: d.avatar };
  }
}

// -216: access token không hợp lệ; -124: access token hết hạn (theo nguồn phụ, cần xác minh)
export const ZALO_AUTH_ERRORS = new Set([-216, -124]);

export function mapZaloResult(r: Awaited<ReturnType<typeof platformFetch>>): SendOutcome {
  if (r.kind === 'timeout') return { outcome: 'unknown', message: 'Hết thời gian chờ phản hồi từ Zalo; chưa rõ tin đã được gửi hay chưa' };
  if (r.kind === 'network_unknown') return { outcome: 'unknown', message: `Mất kết nối khi đang gửi (${r.error})` };
  if (r.kind === 'network_before_send') return { outcome: 'failed', retryable: true, code: 'NETWORK', message: `Không kết nối được tới Zalo (${r.error})` };
  if (r.status === 429) return { outcome: 'failed', retryable: true, code: 'ZALO_429', message: 'Zalo giới hạn tốc độ gọi API' };
  if (r.status >= 500) return { outcome: 'unknown', message: `Zalo trả lỗi ${r.status}; chưa rõ tin đã được gửi hay chưa` };
  const err = Number(r.body?.error);
  if (err === 0) return { outcome: 'accepted', externalId: r.body?.data?.message_id, raw: r.body?.data };
  const message = String(r.body?.message ?? `Lỗi Zalo ${err}`);
  if (ZALO_AUTH_ERRORS.has(err)) return { outcome: 'failed', retryable: false, code: `ZALO_${err}`, message: 'Access token Zalo hết hạn hoặc không hợp lệ', authError: true };
  if (err === -223) return { outcome: 'failed', retryable: false, code: 'ZALO_-223', message: 'Đã vượt hạn mức gửi tin của OA' };
  if (err === -213) return { outcome: 'failed', retryable: false, code: 'ZALO_-213', message: 'Người dùng chưa quan tâm OA hoặc đã bỏ quan tâm', recipientUnavailable: true };
  return { outcome: 'failed', retryable: false, code: `ZALO_${err}`, message };
}
