import { createHash } from 'crypto';
import { NormalizedEvent } from './types';

/**
 * Chuẩn hoá webhook Zalo OA. Tên sự kiện và cấu trúc lấy theo nguồn phụ (xem docs/PLATFORM_SOURCES.md),
 * CẦN đối chiếu lại với tài liệu chính thức trước khi chạy thật.
 */
export function parseZalo(body: any): NormalizedEvent[] {
  if (!body || typeof body.event_name !== 'string') return [];
  const name: string = body.event_name;
  const ts = new Date(Number(body.timestamp ?? Date.now()));
  const senderId = body.sender?.id ? String(body.sender.id) : '';
  const recipientId = body.recipient?.id ? String(body.recipient.id) : '';
  const oaId = body.oa_id ? String(body.oa_id) : '';
  const m = body.message ?? {};
  const base = { provider: 'ZALO' as const, timestamp: ts, raw: body };

  if (name.startsWith('user_send_')) {
    const atts = (m.attachments ?? []).map((a: any) => ({ type: String(a.type ?? name.replace('user_send_', '')), url: a.payload?.url ?? a.payload?.thumbnail, name: a.payload?.name }));
    const mid = String(m.msg_id ?? `${senderId}:${body.timestamp}:${h(JSON.stringify(m))}`);
    return [{ ...base, type: 'message', direction: 'inbound', channelCandidates: [recipientId, oaId].filter(Boolean), eventKey: `msg:${mid}`, userExternalId: senderId, externalMessageId: mid, text: typeof m.text === 'string' ? m.text : undefined, attachments: atts.length ? atts : undefined }];
  }
  if (name.startsWith('oa_send_')) {
    const mid = String(m.msg_id ?? `${recipientId}:${body.timestamp}:${h(JSON.stringify(m))}`);
    return [{ ...base, type: 'message', direction: 'echo', channelCandidates: [senderId, oaId].filter(Boolean), eventKey: `msg:${mid}`, userExternalId: recipientId, externalMessageId: mid, text: typeof m.text === 'string' ? m.text : undefined }];
  }
  if (name === 'user_received_message' || name === 'user_seen_message') {
    const ids: string[] = (m.msg_ids ?? (m.msg_id ? [m.msg_id] : [])).map(String);
    // Với sự kiện này, OA có thể nằm ở sender hoặc recipient → thử cả hai
    const user = recipientId || senderId;
    return [{ ...base, type: name === 'user_received_message' ? 'delivery' : 'read', channelCandidates: [senderId, recipientId, oaId].filter(Boolean), eventKey: `${name}:${ids.join(',') || body.timestamp}`, userExternalId: user, mids: ids }];
  }
  if (name === 'follow' || name === 'unfollow') {
    const user = String(body.follower?.id ?? senderId);
    return [{ ...base, type: name, channelCandidates: [oaId, recipientId].filter(Boolean), eventKey: `${name}:${user}:${body.timestamp}`, userExternalId: user }];
  }
  return [{ ...base, type: 'ignored', channelCandidates: [oaId, recipientId, senderId].filter(Boolean), eventKey: `${name}:${body.timestamp}:${h(JSON.stringify(body))}`, reason: `Sự kiện ${name} chưa hỗ trợ` }];
}

function h(s: string) {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}
