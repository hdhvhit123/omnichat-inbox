import { Injectable } from '@nestjs/common';
import { Conversation, Message } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { SimFailure, SimulatedAdapter } from '../channels/adapters/simulated.adapter';
import { parseFacebook } from '../webhooks/facebook.parser';
import { parseZalo } from '../webhooks/zalo.parser';
import { WebhookIngestService } from '../webhooks/webhook-ingest.service';

/**
 * Mô phỏng tin đến / xác nhận giao-đọc cho workspace demo. Payload được dựng đúng định dạng
 * webhook của từng nền tảng rồi đi qua CÙNG bộ phân tích + lưu + hàng đợi như webhook thật
 * (chỉ bỏ qua bước kiểm tra chữ ký). Không gọi API nền tảng thật.
 */
@Injectable()
export class SimulatorService {
  constructor(
    private prisma: PrismaService,
    private ingest: WebhookIngestService,
    private queue: QueueService,
    private adapter: SimulatedAdapter,
  ) {}

  private async demoChannel(workspaceId: string, channelId: string) {
    const ch = await this.prisma.channel.findFirst({ where: { id: channelId, workspaceId, isSimulated: true }, include: { workspace: true } });
    if (!ch || !ch.workspace.isDemo) throw new AppError('NOT_DEMO', 'Chỉ mô phỏng được trên kênh mô phỏng của workspace demo', 400);
    return ch;
  }

  async simulateInbound(workspaceId: string, input: { channelId: string; userExternalId?: string; customerName?: string; text: string; at?: Date }) {
    const ch = await this.demoChannel(workspaceId, input.channelId);
    const user = input.userExternalId ?? `sim_user_${randomBytes(4).toString('hex')}`;
    const ts = (input.at ?? new Date()).getTime();
    const mid = `${ch.type === 'FACEBOOK' ? 'm_in_' : 'zin_'}${randomBytes(8).toString('hex')}`;
    const events =
      ch.type === 'FACEBOOK'
        ? parseFacebook({ object: 'page', entry: [{ id: ch.externalId, time: ts, messaging: [{ sender: { id: user }, recipient: { id: ch.externalId }, timestamp: ts, message: { mid, text: input.text } }] }] })
        : parseZalo({ app_id: 'demo', event_name: 'user_send_text', timestamp: String(ts), sender: { id: user }, recipient: { id: ch.externalId }, message: { msg_id: mid, text: input.text } });
    if (input.customerName) for (const e of events) if (e.type === 'message') e.profileName = input.customerName;
    const result = await this.ingest.ingest(events);
    return { ...result, userExternalId: user, externalMessageId: mid, simulated: true };
  }

  async injectFailure(workspaceId: string, channelId: string, failure: SimFailure) {
    await this.demoChannel(workspaceId, channelId);
    await this.adapter.injectFailure(channelId, failure);
  }

  /** Sau khi adapter mô phỏng chấp nhận tin: hẹn giờ gửi xác nhận "đã giao" rồi "đã đọc". */
  async afterAccepted(channelId: string, conversation: Conversation, m: Message) {
    const ch = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!ch?.isSimulated || !m.externalId) return;
    const identity = await this.prisma.customerIdentity.findUniqueOrThrow({ where: { id: conversation.identityId } });
    await this.queue.add(QUEUES.maintenance, { task: 'sim-receipt', channelId, user: identity.externalUserId, mid: m.externalId, kind: 'delivery' }, { delayMs: 1500 });
    await this.queue.add(QUEUES.maintenance, { task: 'sim-receipt', channelId, user: identity.externalUserId, mid: m.externalId, kind: 'read' }, { delayMs: 5000 });
  }

  async receipt(data: { channelId: string; user: string; mid: string; kind: 'delivery' | 'read' }) {
    const ch = await this.prisma.channel.findUnique({ where: { id: data.channelId } });
    if (!ch?.isSimulated) return;
    const ts = Date.now();
    const events =
      ch.type === 'FACEBOOK'
        ? parseFacebook({
            object: 'page',
            entry: [{ id: ch.externalId, time: ts, messaging: [{ sender: { id: data.user }, recipient: { id: ch.externalId }, timestamp: ts, ...(data.kind === 'delivery' ? { delivery: { mids: [data.mid], watermark: ts } } : { read: { watermark: ts } }) }] }],
          })
        : parseZalo({ app_id: 'demo', event_name: data.kind === 'delivery' ? 'user_received_message' : 'user_seen_message', timestamp: String(ts), sender: { id: ch.externalId }, recipient: { id: data.user }, message: { msg_ids: [data.mid] } });
    await this.ingest.ingest(events);
  }
}
