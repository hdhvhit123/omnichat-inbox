import { createHash } from 'crypto';
import { NormalizedEvent } from './types';

/**
 * Chuẩn hoá payload webhook Messenger (object = "page").
 * Nguồn: https://developers.facebook.com/docs/messenger-platform/webhooks (kiểm tra 2026-10-29)
 */
export function parseFacebook(body: any): NormalizedEvent[] {
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return [];
  const out: NormalizedEvent[] = [];
  for (const entry of body.entry) {
    const pageId = String(entry.id ?? '');
    for (const ev of entry.messaging ?? []) {
      const ts = new Date(Number(ev.timestamp ?? entry.time ?? Date.now()));
      const senderId = String(ev.sender?.id ?? '');
      const recipientId = String(ev.recipient?.id ?? '');
      const base = { provider: 'FACEBOOK' as const, channelCandidates: [pageId], timestamp: ts, raw: ev };
      if (ev.message) {
        const m = ev.message;
        const isEcho = m.is_echo === true;
        const attachments = (m.attachments ?? []).map((a: any) => ({ type: String(a.type ?? 'file'), url: a.payload?.url, name: a.payload?.title ?? a.name }));
        if (!m.mid) continue;
        out.push({
          ...base,
          type: 'message',
          direction: isEcho ? 'echo' : 'inbound',
          eventKey: `msg:${m.mid}`,
          userExternalId: isEcho ? recipientId : senderId,
          externalMessageId: String(m.mid),
          text: typeof m.text === 'string' ? m.text : undefined,
          attachments: attachments.length ? attachments : undefined,
          metadata: typeof m.metadata === 'string' ? m.metadata : undefined,
          appId: m.app_id ? String(m.app_id) : undefined,
        });
      } else if (ev.postback) {
        const p = ev.postback;
        const key = p.mid ? `pb:${p.mid}` : `pb:${senderId}:${ev.timestamp}:${hash(p.payload)}`;
        out.push({
          ...base,
          type: 'message',
          direction: 'inbound',
          eventKey: key,
          userExternalId: senderId,
          externalMessageId: p.mid ?? key,
          text: p.title ?? p.payload,
          isPostback: true,
        });
      } else if (ev.delivery) {
        const d = ev.delivery;
        out.push({ ...base, type: 'delivery', eventKey: `delivery:${senderId}:${d.watermark}:${hash((d.mids ?? []).join(','))}`, userExternalId: senderId, mids: d.mids, watermark: Number(d.watermark) || undefined });
      } else if (ev.read) {
        out.push({ ...base, type: 'read', eventKey: `read:${senderId}:${ev.read.watermark}`, userExternalId: senderId, watermark: Number(ev.read.watermark) || undefined });
      } else {
        out.push({ ...base, type: 'ignored', eventKey: `other:${senderId}:${ev.timestamp}:${hash(JSON.stringify(ev))}`, reason: 'Loại sự kiện chưa hỗ trợ' });
      }
    }
  }
  return out;
}

function hash(s: unknown) {
  return createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 12);
}
