import { Injectable } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { createHmac } from 'crypto';
import { config } from '../../config';
import { platformFetch } from '../../common/http';
import { ChannelAdapter, OutgoingMessage, SendOutcome, VerifyOutcome } from './types';

/**
 * Messenger Platform — Send API: POST /{version}/{PAGE-ID}/messages
 * Nguồn: https://developers.facebook.com/docs/messenger-platform/reference/send-api (kiểm tra 2026-10-29)
 */
@Injectable()
export class FacebookAdapter implements ChannelAdapter {
  readonly kind = 'facebook' as const;

  private base() {
    const c = config();
    return `${c.META_GRAPH_BASE}/${c.META_GRAPH_VERSION}`;
  }

  private proof(token: string) {
    const secret = config().META_APP_SECRET;
    return secret ? `&appsecret_proof=${createHmac('sha256', secret).update(token).digest('hex')}` : '';
  }

  async send(channel: Channel, token: string, msg: OutgoingMessage): Promise<SendOutcome> {
    if (channel.isSimulated) throw new Error('Adapter thật không được dùng cho kênh mô phỏng');
    const message: Record<string, unknown> = { metadata: `omni:${msg.outboundId}` };
    if (msg.attachment) {
      message.attachment = { type: msg.attachment.type, payload: { url: msg.attachment.url, is_reusable: false } };
    } else {
      message.text = msg.text ?? '';
    }
    const body: Record<string, unknown> = {
      recipient: { id: msg.recipientId },
      messaging_type: msg.sendParams.messagingType ?? 'RESPONSE',
      message,
    };
    if (msg.sendParams.messagingType === 'MESSAGE_TAG') body.tag = msg.sendParams.tag;

    const url = `${this.base()}/${channel.externalId}/messages?access_token=${encodeURIComponent(token)}${this.proof(token)}`;
    const r = await platformFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return mapFacebookResult(r);
  }

  async verify(channel: Channel, token: string): Promise<VerifyOutcome> {
    const url = `${this.base()}/${channel.externalId}?fields=id,name,picture&access_token=${encodeURIComponent(token)}${this.proof(token)}`;
    const r = await platformFetch(url);
    if (r.kind !== 'response') return { ok: false, code: r.kind.toUpperCase(), message: 'Không kết nối được tới Graph API' };
    if (r.status >= 400 || r.body?.error) {
      const e = r.body?.error ?? {};
      return { ok: false, code: `FB_${e.code ?? r.status}`, message: e.message ?? 'Lỗi Graph API', authError: e.code === 190 || e.code === 10 || (e.code >= 200 && e.code < 300) };
    }
    // Kiểm tra ứng dụng đã đăng ký webhook cho Page chưa
    const sub = await platformFetch(`${this.base()}/${channel.externalId}/subscribed_apps?access_token=${encodeURIComponent(token)}${this.proof(token)}`);
    let detail = 'Chưa kiểm tra được đăng ký webhook';
    if (sub.kind === 'response' && Array.isArray(sub.body?.data)) {
      const mine = sub.body.data.find((a: any) => String(a.id) === String(config().META_APP_ID));
      detail = mine ? `Đã đăng ký webhook: ${(mine.subscribed_fields ?? []).join(', ')}` : 'Ứng dụng CHƯA đăng ký webhook cho Page này';
    }
    return { ok: true, externalId: String(r.body.id), name: r.body.name, avatarUrl: r.body.picture?.data?.url, detail };
  }

  /** POST /{page-id}/subscribed_apps — đăng ký nhận webhook cho Page. */
  async subscribePage(pageId: string, token: string) {
    const fields = 'messages,message_echoes,message_deliveries,message_reads,messaging_postbacks';
    return platformFetch(`${this.base()}/${pageId}/subscribed_apps?subscribed_fields=${fields}&access_token=${encodeURIComponent(token)}${this.proof(token)}`, { method: 'POST' });
  }

  async unsubscribePage(pageId: string, token: string) {
    return platformFetch(`${this.base()}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(token)}${this.proof(token)}`, { method: 'DELETE' });
  }
}

// Mã lỗi Graph API giới hạn tốc độ: 4 (app), 17 (user), 32 (page), 613 (call rate)
const FB_RATE_LIMIT = new Set([4, 17, 32, 613]);

export function mapFacebookResult(r: Awaited<ReturnType<typeof platformFetch>>): SendOutcome {
  if (r.kind === 'timeout') return { outcome: 'unknown', message: 'Hết thời gian chờ phản hồi từ Facebook; chưa rõ tin đã được gửi hay chưa' };
  if (r.kind === 'network_unknown') return { outcome: 'unknown', message: `Mất kết nối khi đang gửi (${r.error})` };
  if (r.kind === 'network_before_send') return { outcome: 'failed', retryable: true, code: 'NETWORK', message: `Không kết nối được tới Facebook (${r.error})` };
  if (r.status < 300 && r.body?.message_id) return { outcome: 'accepted', externalId: r.body.message_id, raw: r.body };
  const e = r.body?.error ?? {};
  const code = Number(e.code);
  const message = String(e.message ?? `HTTP ${r.status}`);
  if (code === 190) return { outcome: 'failed', retryable: false, code: 'FB_190', message: 'Token Page hết hạn hoặc không hợp lệ. Cần cấp quyền lại.', authError: true };
  if (FB_RATE_LIMIT.has(code) || r.status === 429) {
    const retryAfter = Number(r.headers.get('retry-after'));
    return { outcome: 'failed', retryable: true, code: `FB_${code || 429}`, message: 'Facebook giới hạn tốc độ gọi API', retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : undefined };
  }
  if (code === 10 || (code >= 200 && code < 300)) {
    // Bao gồm gửi ngoài cửa sổ cho phép (subcode 2018278) và thiếu quyền pages_messaging
    return { outcome: 'failed', retryable: false, code: `FB_${code}_${e.error_subcode ?? ''}`, message: `Facebook từ chối do quyền/chính sách: ${message}`, authError: code >= 200 && code < 300 };
  }
  if (code === 551 || e.error_subcode === 1545041) return { outcome: 'failed', retryable: false, code: 'FB_551', message: 'Người nhận hiện không thể nhận tin', recipientUnavailable: true };
  if (e.is_transient === true) return { outcome: 'failed', retryable: true, code: `FB_${code}`, message };
  if (r.status >= 500) return { outcome: 'unknown', message: `Facebook trả lỗi ${r.status}; chưa rõ tin đã được gửi hay chưa` };
  return { outcome: 'failed', retryable: false, code: `FB_${code || r.status}`, message };
}
