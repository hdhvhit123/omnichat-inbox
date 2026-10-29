import { Injectable } from '@nestjs/common';
import { Conversation, Message, OutboundRequester, Prisma } from '@prisma/client';
import { AppError } from '../common/errors';
import { normalizeVi, preview } from '../common/text';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { attachmentKind } from '../files/storage.service';
import { serializeMessage } from '../inbox/serializers';
import { SendPolicyService } from './send-policy.service';

export interface QueueSendInput {
  workspaceId: string;
  conversationId: string;
  requestedBy: OutboundRequester;
  authorId?: string | null;
  text?: string | null;
  fileId?: string | null;
  /** Khoá idempotent: bấm gửi 2 lần / job chạy lại không tạo 2 tin */
  clientMsgId: string;
  ruleId?: string | null;
  aiTaskId?: string | null;
}

export type QueueSendResult =
  | { ok: true; message: Message; duplicate: boolean }
  | { ok: false; code: string; reason: string };

/**
 * Điểm vào DUY NHẤT để gửi tin ra kênh. Ghi chú nội bộ không đi qua đây (bảng riêng),
 * nên không có đường nào gửi ghi chú ra Facebook/Zalo.
 */
@Injectable()
export class OutboxService {
  constructor(
    private prisma: PrismaService,
    private policy: SendPolicyService,
    private queue: QueueService,
    private realtime: RealtimePublisher,
  ) {}

  async queueSend(input: QueueSendInput): Promise<QueueSendResult> {
    const existing = await this.prisma.message.findUnique({ where: { workspaceId_clientMsgId: { workspaceId: input.workspaceId, clientMsgId: input.clientMsgId } } });
    if (existing) return { ok: true, message: existing, duplicate: true };

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, workspaceId: input.workspaceId },
      include: { channel: { include: { workspace: true } }, identity: true },
    });
    if (!conversation) throw new AppError('NOT_FOUND', 'Hội thoại không tồn tại', 404);

    let file = null;
    if (input.fileId) {
      file = await this.prisma.fileObject.findFirst({ where: { id: input.fileId, workspaceId: input.workspaceId } });
      if (!file) throw new AppError('NOT_FOUND', 'Tệp không tồn tại', 404);
    }
    const attachment = file ? { type: attachmentKind(file.mime), mime: file.mime, size: file.size } : null;

    const decision = await this.policy.check({
      workspace: conversation.channel.workspace,
      channel: conversation.channel,
      conversation,
      identity: conversation.identity,
      requestedBy: input.requestedBy,
      text: input.text,
      attachment,
    });
    if (!decision.allowed) return { ok: false, code: decision.code, reason: decision.reason };

    const result = await this.prisma.$transaction(async (tx) => {
      // Khoá hàng hội thoại: tuần tự hoá giữa nhân viên tiếp quản và bot gửi
      const [conv] = await tx.$queryRaw<Conversation[]>`SELECT * FROM "Conversation" WHERE id = ${conversation.id} FOR UPDATE`;
      if (input.requestedBy === 'BOT' || input.requestedBy === 'RULE') {
        if (conv.botPausedAt) return { blocked: 'Nhân viên đã tiếp quản hội thoại, bot không gửi.' } as const;
      }
      const now = new Date();
      const attachments = file ? ([{ fileId: file.id, type: attachment!.type, name: file.filename, mime: file.mime, size: file.size }] as Prisma.InputJsonValue) : undefined;
      let message: Message;
      try {
        message = await tx.message.create({
          data: {
            workspaceId: input.workspaceId,
            conversationId: conv.id,
            channelId: conv.channelId,
            direction: 'OUTBOUND',
            senderType: input.requestedBy === 'AGENT' ? 'AGENT' : input.requestedBy === 'SYSTEM' ? 'SYSTEM' : 'BOT',
            authorId: input.authorId ?? null,
            text: input.text?.trim() || null,
            attachments,
            status: 'PENDING',
            sentAt: now,
            clientMsgId: input.clientMsgId,
            ruleId: input.ruleId ?? null,
            aiTaskId: input.aiTaskId ?? null,
            searchText: normalizeVi(input.text),
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicateKey: true } as const;
        throw e;
      }
      await tx.outboundMessage.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: conv.id,
          channelId: conv.channelId,
          messageId: message.id,
          requestedBy: input.requestedBy,
          sendParams: decision.sendParams as Prisma.InputJsonValue,
        },
      });

      const convUpdate: Prisma.ConversationUpdateInput = {
        lastMessageAt: now,
        lastMessagePreview: preview(input.text ?? (file ? `[Tệp] ${file.filename}` : '')),
      };
      if (input.requestedBy === 'AGENT') {
        // Nhân viên gửi = tiếp quản: dừng bot ngay, huỷ tác vụ bot đang chờ
        Object.assign(convUpdate, {
          botPausedAt: conv.botPausedAt ?? now,
          botPausedById: conv.botPausedById ?? input.authorId ?? 'agent',
          botPausedReason: conv.botPausedAt ? undefined : 'Nhân viên đã trả lời',
          firstHumanReplyAt: conv.firstHumanReplyAt ?? now,
          unreadCount: 0,
          status: conv.status === 'NEW' ? 'OPEN' : undefined,
          assigneeId: conv.assigneeId ?? input.authorId ?? undefined,
        });
        await tx.aiTask.updateMany({ where: { conversationId: conv.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', reason: 'Nhân viên đã tiếp quản' } });
        const pending = await tx.outboundMessage.findMany({ where: { conversationId: conv.id, status: 'QUEUED', requestedBy: { in: ['BOT', 'RULE'] } } });
        if (pending.length) {
          await tx.outboundMessage.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: 'CANCELLED', lastError: 'Nhân viên đã tiếp quản' } });
          await tx.message.updateMany({ where: { id: { in: pending.map((p) => p.messageId) } }, data: { status: 'CANCELLED', errorMessage: 'Nhân viên đã tiếp quản' } });
        }
        if (!conv.assigneeId && input.authorId) {
          await tx.assignmentEvent.create({ data: { workspaceId: input.workspaceId, conversationId: conv.id, toUserId: input.authorId, actorId: input.authorId } });
        }
      }
      const updatedConv = await tx.conversation.update({ where: { id: conv.id }, data: convUpdate });
      return { message, conversation: updatedConv } as const;
    });

    if ('blocked' in result) return { ok: false, code: 'BOT_PAUSED', reason: result.blocked! };
    if ('duplicateKey' in result) {
      const m = await this.prisma.message.findUniqueOrThrow({ where: { workspaceId_clientMsgId: { workspaceId: input.workspaceId, clientMsgId: input.clientMsgId } } });
      return { ok: true, message: m, duplicate: true };
    }
    const rooms = this.realtime.conversationRooms(result.conversation);
    this.realtime.emit(rooms, 'message.created', { conversationId: result.conversation.id, message: serializeMessage(result.message) });
    this.realtime.emit(rooms, 'conversation.updated', { conversationId: result.conversation.id, channelId: result.conversation.channelId });
    const outbound = await this.prisma.outboundMessage.findUniqueOrThrow({ where: { messageId: result.message.id } });
    await this.queue.add(QUEUES.outbound, { outboundId: outbound.id }, { jobId: `ob-${outbound.id}-0`, attempts: 1 });
    return { ok: true, message: result.message, duplicate: false };
  }
}
