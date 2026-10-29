import { Injectable, Logger } from '@nestjs/common';
import { Channel, Conversation, Message, Prisma } from '@prisma/client';
import { normalizeVi, preview } from '../common/text';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { AutomationService } from '../rules/automation.service';
import { serializeMessage } from '../inbox/serializers';
import { NormalizedEvent } from './types';

type Tx = Prisma.TransactionClient;

/** Kết quả xử lý một sự kiện, dùng cho các bước sau khi commit. */
interface Outcome {
  conversation?: Conversation;
  message?: Message;
  updatedMessages?: Message[];
  isNewConversation?: boolean;
  triggerAutomation?: boolean;
}

// Tin đến muộn hơn ngưỡng này (so với hiện tại) sẽ được lưu nhưng không kích hoạt bot
const STALE_AUTOMATION_MS = 30 * 60_000;

@Injectable()
export class WebhookProcessorService {
  private readonly log = new Logger('WebhookProcessor');

  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private realtime: RealtimePublisher,
    private automation: AutomationService,
  ) {}

  register() {
    this.queue.register(QUEUES.webhook, async (data: { webhookEventId: string }, job) => {
      try {
        await this.process(data.webhookEventId);
      } catch (e: any) {
        const final = !job || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        await this.prisma.webhookEvent.update({
          where: { id: data.webhookEventId },
          data: { attempts: { increment: 1 }, error: String(e?.message ?? e).slice(0, 1000), status: final ? 'FAILED' : 'RECEIVED' },
        });
        throw e;
      }
    });
  }

  async process(webhookEventId: string) {
    const row = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!row || row.status === 'PROCESSED' || row.status === 'IGNORED') return;
    const ev = row.payload as unknown as NormalizedEvent & { channelExternalId: string; timestamp: string };
    const channel = await this.prisma.channel.findUnique({ where: { type_externalId: { type: row.provider, externalId: row.channelExternalId } } });
    if (!channel) {
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { status: 'IGNORED', error: 'Kênh không còn tồn tại', processedAt: new Date() } });
      return;
    }
    const timestamp = new Date(ev.timestamp);
    const userId = 'userExternalId' in ev ? ev.userExternalId : '';

    // Tuần tự hoá theo (kênh, khách): khoá advisory trong transaction
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`conv:${channel.id}:${userId}`}))`;
        let result: Outcome = {};
        switch (ev.type) {
          case 'message':
            result = ev.direction === 'inbound' ? await this.inbound(tx, channel, ev, timestamp) : await this.echo(tx, channel, ev, timestamp);
            break;
          case 'delivery':
          case 'read':
            result = await this.receipt(tx, channel, ev, timestamp);
            break;
          case 'follow':
          case 'unfollow':
            await tx.customerIdentity.updateMany({
              where: { channelId: channel.id, externalUserId: ev.userExternalId },
              data: ev.type === 'follow' ? { canReceive: true, cannotReceiveReason: null } : { canReceive: false, cannotReceiveReason: 'Người dùng đã bỏ quan tâm OA' },
            });
            break;
        }
        await tx.webhookEvent.update({ where: { id: row.id }, data: { status: 'PROCESSED', processedAt: new Date(), error: null } });
        return result;
      },
      { timeout: 20_000 },
    );

    this.publish(channel, outcome);
    if (outcome.triggerAutomation && outcome.message && outcome.conversation) {
      await this.automation.onInbound(outcome.message.id, { isNewConversation: !!outcome.isNewConversation });
    }
  }

  private publish(channel: Channel, o: Outcome) {
    if (!o.conversation) return;
    const rooms = this.realtime.conversationRooms(o.conversation);
    if (o.message) this.realtime.emit(rooms, 'message.created', { conversationId: o.conversation.id, message: serializeMessage(o.message) });
    for (const m of o.updatedMessages ?? []) this.realtime.emit(rooms, 'message.updated', { conversationId: o.conversation.id, message: serializeMessage(m) });
    this.realtime.emit(rooms, 'conversation.updated', { conversationId: o.conversation.id, channelId: channel.id, isNew: !!o.isNewConversation });
  }

  /** Tìm hoặc tạo định danh khách + hồ sơ + hội thoại. */
  private async ensureConversation(tx: Tx, channel: Channel, userExternalId: string, profileName?: string) {
    let identity = await tx.customerIdentity.findUnique({ where: { channelId_externalUserId: { channelId: channel.id, externalUserId: userExternalId } } });
    if (!identity) {
      const label = channel.type === 'FACEBOOK' ? 'Khách Facebook' : 'Khách Zalo';
      const displayName = profileName?.slice(0, 100) || `${label} •${userExternalId.slice(-4)}`;
      // Không tự gộp hồ sơ: mỗi định danh kênh mới → một hồ sơ khách mới
      const customer = await tx.customer.create({
        data: { workspaceId: channel.workspaceId, displayName, source: `${channel.type === 'FACEBOOK' ? 'Facebook' : 'Zalo'}: ${channel.name}`, searchText: normalizeVi(displayName) },
      });
      identity = await tx.customerIdentity.create({
        data: { workspaceId: channel.workspaceId, customerId: customer.id, channelId: channel.id, externalUserId: userExternalId, displayName },
      });
    }
    let conversation = await tx.conversation.findUnique({ where: { identityId: identity.id } });
    let isNew = false;
    if (!conversation) {
      conversation = await tx.conversation.create({
        data: { workspaceId: channel.workspaceId, channelId: channel.id, customerId: identity.customerId, identityId: identity.id, status: 'NEW' },
      });
      isNew = true;
    }
    return { identity, conversation, isNew };
  }

  private async inbound(tx: Tx, channel: Channel, ev: Extract<NormalizedEvent, { type: 'message' }>, ts: Date): Promise<Outcome> {
    const { identity, conversation, isNew } = await this.ensureConversation(tx, channel, ev.userExternalId, ev.profileName);
    const existing = await tx.message.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: ev.externalMessageId } } });
    if (existing) return {}; // trùng: đã lưu trước đó, không kích hoạt lại

    const text = ev.text ?? null;
    const message = await tx.message.create({
      data: {
        workspaceId: channel.workspaceId,
        conversationId: conversation.id,
        channelId: channel.id,
        direction: 'INBOUND',
        senderType: 'CUSTOMER',
        text,
        attachments: ev.attachments ? (ev.attachments as unknown as Prisma.InputJsonValue) : undefined,
        externalId: ev.externalMessageId,
        status: 'RECEIVED',
        sentAt: ts,
        searchText: normalizeVi(text),
      },
    });

    const isLatest = !conversation.lastInboundAt || ts >= conversation.lastInboundAt;
    const reopen = conversation.status === 'RESOLVED' || conversation.status === 'PENDING';
    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastInboundAt: isLatest ? ts : undefined,
        firstInboundAt: conversation.firstInboundAt ?? ts,
        lastMessageAt: !conversation.lastMessageAt || ts > conversation.lastMessageAt ? ts : undefined,
        lastMessagePreview: isLatest ? preview(text ?? attachmentLabel(ev.attachments)) : undefined,
        unreadCount: { increment: 1 },
        status: reopen ? (conversation.assigneeId ? 'OPEN' : 'NEW') : undefined,
        resolvedAt: reopen ? null : undefined,
      },
    });
    if (isLatest) await tx.customerIdentity.update({ where: { id: identity.id }, data: { lastInboundAt: ts, canReceive: true, cannotReceiveReason: null } });

    const fresh = Date.now() - ts.getTime() < STALE_AUTOMATION_MS;
    return { conversation: updated, message, isNewConversation: isNew, triggerAutomation: isLatest && fresh };
  }

  /** Tin do chính Page/OA gửi (echo): đối soát với outbox, không bao giờ kích hoạt bot. */
  private async echo(tx: Tx, channel: Channel, ev: Extract<NormalizedEvent, { type: 'message' }>, ts: Date): Promise<Outcome> {
    const { conversation } = await this.ensureConversation(tx, channel, ev.userExternalId);
    const byExternal = await tx.message.findUnique({ where: { channelId_externalId: { channelId: channel.id, externalId: ev.externalMessageId } } });
    if (byExternal) {
      if (byExternal.status === 'UNKNOWN' || byExternal.status === 'PENDING') {
        const m = await tx.message.update({ where: { id: byExternal.id }, data: { status: 'ACCEPTED', errorMessage: null } });
        await tx.outboundMessage.updateMany({ where: { messageId: m.id }, data: { status: 'ACCEPTED' } });
        return { conversation, updatedMessages: [m] };
      }
      return {};
    }

    // Facebook: metadata "omni:<outboundId>" do hệ thống gắn khi gửi
    let outboundId: string | null = ev.metadata?.startsWith('omni:') ? ev.metadata.slice(5) : null;
    if (!outboundId && channel.type === 'ZALO' && ev.text) {
      // Zalo không có metadata: đối soát tin UNKNOWN cùng nội dung trong 15 phút gần nhất
      const candidate = await tx.message.findFirst({
        where: { conversationId: conversation.id, direction: 'OUTBOUND', status: { in: ['UNKNOWN', 'PENDING'] }, externalId: null, text: ev.text, sentAt: { gte: new Date(ts.getTime() - 15 * 60_000) } },
        include: { outbound: true },
        orderBy: { sentAt: 'asc' },
      });
      outboundId = candidate?.outbound?.id ?? null;
    }
    if (outboundId) {
      const ob = await tx.outboundMessage.findFirst({ where: { id: outboundId, channelId: channel.id } });
      if (ob) {
        const current = await tx.message.findUniqueOrThrow({ where: { id: ob.messageId } });
        const upgrade = current.status === 'PENDING' || current.status === 'UNKNOWN';
        const m = await tx.message.update({
          where: { id: ob.messageId },
          data: { externalId: current.externalId ?? ev.externalMessageId, status: upgrade ? 'ACCEPTED' : undefined, errorMessage: upgrade ? null : undefined },
        });
        await tx.outboundMessage.update({ where: { id: ob.id }, data: { status: 'ACCEPTED' } });
        return { conversation, updatedMessages: [m] };
      }
    }

    // Tin gửi từ công cụ khác (Meta Business Suite, Zalo OA Manager...)
    const text = ev.text ?? null;
    const message = await tx.message.create({
      data: {
        workspaceId: channel.workspaceId,
        conversationId: conversation.id,
        channelId: channel.id,
        direction: 'OUTBOUND',
        senderType: 'AGENT',
        text,
        attachments: ev.attachments ? (ev.attachments as unknown as Prisma.InputJsonValue) : undefined,
        externalId: ev.externalMessageId,
        status: 'ACCEPTED',
        sentAt: ts,
        sentOutsideSystem: true,
        searchText: normalizeVi(text),
      },
    });
    // Người thật đã trả lời ngoài hệ thống → tạm dừng bot để tránh trả lời trùng
    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: !conversation.lastMessageAt || ts > conversation.lastMessageAt ? ts : undefined,
        lastMessagePreview: preview(text ?? attachmentLabel(ev.attachments)),
        botPausedAt: conversation.botPausedAt ?? new Date(),
        botPausedById: conversation.botPausedById ?? 'external',
        botPausedReason: conversation.botPausedAt ? undefined : 'Có tin trả lời từ công cụ khác của trang',
        firstHumanReplyAt: conversation.firstHumanReplyAt ?? ts,
      },
    });
    await this.cancelPendingBotWork(tx, conversation.id, 'Có tin trả lời từ công cụ khác của trang');
    return { conversation: updated, message };
  }

  async cancelPendingBotWork(tx: Tx, conversationId: string, reason: string) {
    await tx.aiTask.updateMany({ where: { conversationId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', reason } });
    const pending = await tx.outboundMessage.findMany({ where: { conversationId, status: 'QUEUED', requestedBy: { in: ['BOT', 'RULE'] } } });
    if (pending.length) {
      await tx.outboundMessage.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: 'CANCELLED', lastError: reason } });
      await tx.message.updateMany({ where: { id: { in: pending.map((p) => p.messageId) } }, data: { status: 'CANCELLED', errorMessage: reason } });
    }
  }

  /** Đã giao / đã đọc: chỉ cập nhật khi nền tảng gửi bằng chứng. Xử lý được sự kiện đến sai thứ tự. */
  private async receipt(tx: Tx, channel: Channel, ev: Extract<NormalizedEvent, { type: 'delivery' | 'read' }>, _ts: Date): Promise<Outcome> {
    const identity = await tx.customerIdentity.findUnique({ where: { channelId_externalUserId: { channelId: channel.id, externalUserId: ev.userExternalId } } });
    const conversation = identity ? await tx.conversation.findUnique({ where: { identityId: identity.id } }) : null;
    const isRead = ev.type === 'read';
    const target = isRead ? 'READ' : 'DELIVERED';
    const fromStatuses = isRead ? ['ACCEPTED', 'DELIVERED', 'UNKNOWN'] : ['ACCEPTED', 'UNKNOWN'];
    const where: Prisma.MessageWhereInput[] = [];
    if (ev.mids?.length) where.push({ channelId: channel.id, externalId: { in: ev.mids } });
    if (ev.watermark && conversation) {
      where.push({ conversationId: conversation.id, sentAt: { lte: new Date(ev.watermark) } });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: isRead
          ? { readWatermark: maxBig(conversation.readWatermark, ev.watermark) }
          : { deliveredWatermark: maxBig(conversation.deliveredWatermark, ev.watermark) },
      });
    }
    if (!where.length) return {};
    const msgs = await tx.message.findMany({ where: { OR: where, direction: 'OUTBOUND', status: { in: fromStatuses as any } } });
    if (!msgs.length) return { conversation: conversation ?? undefined };
    const now = new Date();
    await tx.message.updateMany({
      where: { id: { in: msgs.map((m) => m.id) } },
      data: isRead ? { status: target, readAt: now, deliveredAt: now } : { status: target, deliveredAt: now },
    });
    const updated = await tx.message.findMany({ where: { id: { in: msgs.map((m) => m.id) } } });
    const conv = conversation ?? (await tx.conversation.findUnique({ where: { id: msgs[0].conversationId } }));
    return { conversation: conv ?? undefined, updatedMessages: updated };
  }
}

function maxBig(current: bigint | null, value: number): bigint {
  const v = BigInt(value);
  return current && current > v ? current : v;
}

function attachmentLabel(atts?: { type: string }[]) {
  if (!atts?.length) return '';
  const t = atts[0].type;
  return t === 'image' ? '[Hình ảnh]' : t === 'video' ? '[Video]' : t === 'audio' ? '[Âm thanh]' : t === 'sticker' ? '[Nhãn dán]' : '[Tệp đính kèm]';
}
