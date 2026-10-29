import { Injectable, Logger } from '@nestjs/common';
import { Conversation, Message, OutboundMessage, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { AdapterRegistry } from '../channels/adapters/adapter.registry';
import { OutgoingAttachment, SendOutcome } from '../channels/adapters/types';
import { CredentialError, CredentialService } from '../channels/credential.service';
import { StorageService } from '../files/storage.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { serializeMessage } from '../inbox/serializers';
import { SimulatorService } from '../demo/simulator.service';
import { SendPolicyService } from './send-policy.service';

const MAX_ATTEMPTS = 5;

/**
 * Gửi tin từ outbox qua adapter. Không khẳng định "exactly once":
 * - Chuyển QUEUED → SENDING dưới khoá hàng, nên một tin chỉ được một worker gửi.
 * - Timeout/mất kết nối giữa chừng → UNKNOWN, KHÔNG retry tự động (tránh tin trùng);
 *   đối soát qua webhook echo nếu nền tảng gửi về.
 * - Chỉ retry với lỗi chắc chắn chưa gửi (giới hạn tốc độ, chưa kết nối được).
 */
@Injectable()
export class OutboxProcessor {
  private readonly log = new Logger('Outbox');

  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private adapters: AdapterRegistry,
    private credentials: CredentialService,
    private storage: StorageService,
    private realtime: RealtimePublisher,
    private policy: SendPolicyService,
    private simulator: SimulatorService,
  ) {}

  register() {
    this.queue.register(QUEUES.outbound, (data: { outboundId: string; afterRefresh?: boolean }) => this.process(data.outboundId, !!data.afterRefresh));
  }

  async process(outboundId: string, afterRefresh = false): Promise<void> {
    const claim = await this.claim(outboundId);
    if (!claim) return;
    const { outbound, message, conversation } = claim;
    const channel = await this.prisma.channel.findUniqueOrThrow({ where: { id: outbound.channelId } });
    const identity = await this.prisma.customerIdentity.findUniqueOrThrow({ where: { id: conversation.identityId } });

    let attachment: OutgoingAttachment | null = null;
    const att = (message.attachments as any[] | null)?.[0];
    if (att?.fileId) {
      const file = await this.prisma.fileObject.findFirstOrThrow({ where: { id: att.fileId, workspaceId: message.workspaceId } });
      attachment = {
        type: att.type,
        name: file.filename,
        mime: file.mime,
        size: file.size,
        url: await this.storage.signedUrl(file.storageKey, file.filename, 3600),
        data: () => this.storage.get(file.storageKey),
      };
    }

    let outcome: SendOutcome;
    try {
      const token = await this.credentials.accessToken(channel);
      outcome = await this.adapters.for(channel).send(channel, token, {
        outboundId: outbound.id,
        recipientId: identity.externalUserId,
        text: message.text,
        attachment,
        sendParams: (outbound.sendParams ?? {}) as any,
      });
    } catch (e) {
      if (e instanceof CredentialError) {
        outcome = { outcome: 'failed', retryable: false, code: e.code, message: e.message, authError: true };
      } else {
        // Lỗi trước khi gọi API (đọc tệp, giải mã...) → chưa gửi
        outcome = { outcome: 'failed', retryable: true, code: 'INTERNAL', message: String((e as Error).message) };
      }
    }
    await this.apply(outbound, message, conversation, channel.id, outcome, afterRefresh);
  }

  /** Giành quyền gửi: kiểm tra lại quyền xử lý hội thoại và điều kiện gửi ngay trước khi gửi. */
  private async claim(outboundId: string) {
    return this.prisma.$transaction(async (tx) => {
      const ob0 = await tx.outboundMessage.findUnique({ where: { id: outboundId } });
      if (!ob0 || ob0.status !== 'QUEUED') return null;
      const [conversation] = await tx.$queryRaw<Conversation[]>`SELECT * FROM "Conversation" WHERE id = ${ob0.conversationId} FOR UPDATE`;
      const [outbound] = await tx.$queryRaw<OutboundMessage[]>`SELECT * FROM "OutboundMessage" WHERE id = ${outboundId} FOR UPDATE`;
      if (!outbound || outbound.status !== 'QUEUED') return null;
      const message = await tx.message.findUniqueOrThrow({ where: { id: outbound.messageId } });

      const cancel = async (status: 'CANCELLED' | 'BLOCKED', reason: string) => {
        await tx.outboundMessage.update({ where: { id: outbound.id }, data: { status, lastError: reason } });
        const m = await tx.message.update({ where: { id: message.id }, data: { status, errorMessage: reason } });
        this.emitUpdate(conversation, m);
        if (message.aiTaskId) await tx.aiTask.update({ where: { id: message.aiTaskId }, data: { status: status === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED', reason } });
        return null;
      };

      // Người thật đã tiếp quản (botPausedById có giá trị) → huỷ mọi tin bot chưa gửi
      if ((outbound.requestedBy === 'BOT' || outbound.requestedBy === 'RULE') && conversation.botPausedAt && conversation.botPausedById) {
        return cancel('CANCELLED', 'Nhân viên đã tiếp quản hội thoại trước khi bot gửi');
      }
      const full = await tx.conversation.findUniqueOrThrow({ where: { id: conversation.id }, include: { channel: { include: { workspace: true } }, identity: true } });
      const att = (message.attachments as any[] | null)?.[0];
      const decision = await this.policy.check({
        workspace: full.channel.workspace,
        channel: full.channel,
        conversation: full,
        identity: full.identity,
        requestedBy: outbound.requestedBy,
        text: message.text,
        attachment: att ? { type: att.type, mime: att.mime, size: att.size } : null,
      });
      if (!decision.allowed) return cancel('BLOCKED', decision.reason);

      const updated = await tx.outboundMessage.update({
        where: { id: outbound.id },
        data: { status: 'SENDING', attempts: { increment: 1 }, sendParams: decision.sendParams as Prisma.InputJsonValue },
      });
      return { outbound: updated, message, conversation };
    });
  }

  private async apply(outbound: OutboundMessage, message: Message, conversation: Conversation, channelId: string, outcome: SendOutcome, afterRefresh: boolean) {
    const now = new Date();
    if (outcome.outcome === 'accepted') {
      const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      // Nếu webhook đã giao/đã đọc đến trước phản hồi API (sai thứ tự) thì áp dụng ngay
      const sentMs = message.sentAt.getTime();
      const read = conv.readWatermark && Number(conv.readWatermark) >= sentMs;
      const delivered = read || (conv.deliveredWatermark && Number(conv.deliveredWatermark) >= sentMs);
      const current = await this.prisma.message.findUniqueOrThrow({ where: { id: message.id } });
      const alreadyBetter = current.status === 'DELIVERED' || current.status === 'READ';
      let m: Message;
      try {
        m = await this.prisma.message.update({
          where: { id: message.id },
          data: {
            externalId: current.externalId ?? outcome.externalId ?? null,
            status: alreadyBetter ? undefined : read ? 'READ' : delivered ? 'DELIVERED' : 'ACCEPTED',
            deliveredAt: delivered && !alreadyBetter ? now : undefined,
            readAt: read && !alreadyBetter ? now : undefined,
            errorCode: null,
            errorMessage: null,
          },
        });
      } catch (e) {
        // externalId đã được gắn cho bản ghi echo khác → giữ nguyên, chỉ cập nhật trạng thái
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          m = await this.prisma.message.update({ where: { id: message.id }, data: { status: 'ACCEPTED' } });
        } else throw e;
      }
      await this.prisma.outboundMessage.update({ where: { id: outbound.id }, data: { status: 'ACCEPTED', lastError: null, lastErrorCode: null } });
      await this.prisma.channel.update({ where: { id: channelId }, data: { lastApiSuccessAt: now } });
      if (message.aiTaskId) await this.prisma.aiTask.update({ where: { id: message.aiTaskId }, data: { status: 'SENT' } });
      this.emitUpdate(conversation, m);
      await this.simulator.afterAccepted(channelId, conversation, m);
      return;
    }

    if (outcome.outcome === 'unknown') {
      await this.prisma.outboundMessage.update({ where: { id: outbound.id }, data: { status: 'UNKNOWN', lastError: outcome.message } });
      const m = await this.prisma.message.update({
        where: { id: message.id },
        data: { status: 'UNKNOWN', errorCode: 'UNKNOWN', errorMessage: `${outcome.message}. Hệ thống không tự gửi lại để tránh trùng tin; sẽ đối soát nếu nền tảng gửi xác nhận.` },
      });
      this.emitUpdate(conversation, m);
      return;
    }

    // failed
    const channel = await this.prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    if (outcome.authError && channel.type === 'ZALO' && !channel.isSimulated && !afterRefresh) {
      // Thử làm mới token đúng một lần (tuần tự hoá), rồi gửi lại — lỗi xác thực nghĩa là tin chưa được gửi
      try {
        const version = await this.credentials.currentVersion(channelId);
        await this.credentials.refreshZalo(channelId, version);
        await this.prisma.outboundMessage.update({ where: { id: outbound.id }, data: { status: 'QUEUED' } });
        await this.queue.add(QUEUES.outbound, { outboundId: outbound.id, afterRefresh: true }, { jobId: `ob-${outbound.id}-r`, attempts: 1 });
        return;
      } catch {
        /* refresh thất bại → đánh dấu lỗi kênh bên dưới */
      }
    }
    if (outcome.authError) {
      await this.prisma.channel.update({ where: { id: channelId }, data: { status: 'ERROR', lastErrorCode: outcome.code, lastError: outcome.message, lastErrorAt: now } });
      this.realtime.emit([`ws:${channel.workspaceId}:managers`], 'channel.updated', { channelId });
    }
    if (outcome.recipientUnavailable) {
      await this.prisma.customerIdentity.update({ where: { id: conversation.identityId }, data: { canReceive: false, cannotReceiveReason: outcome.message } });
    }
    if (outcome.retryable && outbound.attempts < MAX_ATTEMPTS) {
      const delay = outcome.retryAfterMs ?? Math.min(2 ** outbound.attempts * 2000, 5 * 60_000);
      await this.prisma.outboundMessage.update({
        where: { id: outbound.id },
        data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + delay), lastErrorCode: outcome.code, lastError: outcome.message },
      });
      const m = await this.prisma.message.update({ where: { id: message.id }, data: { errorCode: outcome.code, errorMessage: `${outcome.message} — sẽ thử lại lần ${outbound.attempts + 1}` } });
      this.emitUpdate(conversation, m);
      await this.queue.add(QUEUES.outbound, { outboundId: outbound.id }, { jobId: `ob-${outbound.id}-${outbound.attempts}`, delayMs: delay, attempts: 1 });
      return;
    }
    await this.prisma.outboundMessage.update({ where: { id: outbound.id }, data: { status: 'FAILED', lastErrorCode: outcome.code, lastError: outcome.message } });
    const m = await this.prisma.message.update({ where: { id: message.id }, data: { status: 'FAILED', errorCode: outcome.code, errorMessage: outcome.message } });
    if (message.aiTaskId) await this.prisma.aiTask.update({ where: { id: message.aiTaskId }, data: { status: 'FAILED', error: outcome.message } });
    this.emitUpdate(conversation, m);
  }

  private emitUpdate(conversation: Conversation, m: Message) {
    this.realtime.emit(this.realtime.conversationRooms(conversation), 'message.updated', { conversationId: conversation.id, message: serializeMessage(m) });
  }

  /** Quét định kỳ: job bị mất → đẩy lại; SENDING quá lâu (worker chết giữa chừng) → UNKNOWN. */
  async sweep() {
    const stuckQueued = await this.prisma.outboundMessage.findMany({
      where: { status: 'QUEUED', OR: [{ nextAttemptAt: null, createdAt: { lt: new Date(Date.now() - 60_000) } }, { nextAttemptAt: { lt: new Date(Date.now() - 60_000) } }] },
      take: 100,
    });
    for (const ob of stuckQueued) await this.queue.add(QUEUES.outbound, { outboundId: ob.id }, { jobId: `ob-${ob.id}-sweep-${ob.attempts}`, attempts: 1 });
    const stuckSending = await this.prisma.outboundMessage.findMany({ where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, take: 100 });
    for (const ob of stuckSending) {
      await this.prisma.outboundMessage.update({ where: { id: ob.id }, data: { status: 'UNKNOWN', lastError: 'Tiến trình gửi bị gián đoạn' } });
      await this.prisma.message.update({ where: { id: ob.messageId }, data: { status: 'UNKNOWN', errorMessage: 'Tiến trình gửi bị gián đoạn; chưa rõ tin đã được gửi hay chưa' } });
    }
  }
}
