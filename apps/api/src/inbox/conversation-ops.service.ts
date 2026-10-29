import { Injectable } from '@nestjs/common';
import { BotMode, Conversation, ConversationStatus, Prisma } from '@prisma/client';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';

type Tx = Prisma.TransactionClient;

/** Các thao tác trạng thái hội thoại dùng chung cho nhân viên, quy tắc và AI. */
@Injectable()
export class ConversationOpsService {
  constructor(private prisma: PrismaService, private realtime: RealtimePublisher) {}

  private async lock(tx: Tx, id: string) {
    const [c] = await tx.$queryRaw<Conversation[]>`SELECT * FROM "Conversation" WHERE id = ${id} FOR UPDATE`;
    if (!c) throw new AppError('NOT_FOUND', 'Hội thoại không tồn tại', 404);
    return c;
  }

  async cancelPendingBotWork(tx: Tx, conversationId: string, reason: string) {
    await tx.aiTask.updateMany({ where: { conversationId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', reason } });
    const pending = await tx.outboundMessage.findMany({ where: { conversationId, status: 'QUEUED', requestedBy: { in: ['BOT', 'RULE'] } } });
    if (pending.length) {
      await tx.outboundMessage.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: 'CANCELLED', lastError: reason } });
      await tx.message.updateMany({ where: { id: { in: pending.map((p) => p.messageId) } }, data: { status: 'CANCELLED', errorMessage: reason } });
    }
  }

  /** Nhân viên tiếp quản: dừng bot ngay và huỷ mọi tác vụ bot đang chờ. */
  async takeover(conversationId: string, userId: string, reason = 'Nhân viên tiếp quản') {
    const c = await this.prisma.$transaction(async (tx) => {
      const conv = await this.lock(tx, conversationId);
      await this.cancelPendingBotWork(tx, conv.id, reason);
      return tx.conversation.update({
        where: { id: conv.id },
        data: {
          botPausedAt: conv.botPausedAt ?? new Date(),
          botPausedById: userId,
          botPausedReason: reason,
          assigneeId: conv.assigneeId ?? userId,
          status: conv.status === 'NEW' ? 'OPEN' : undefined,
        },
      });
    });
    this.emit(c, 'conversation.updated');
    return c;
  }

  /** Bật lại bot: chỉ bằng thao tác rõ ràng. */
  async resumeBot(conversationId: string) {
    const c = await this.prisma.conversation.update({ where: { id: conversationId }, data: { botPausedAt: null, botPausedById: null, botPausedReason: null } });
    this.emit(c, 'conversation.updated');
    return c;
  }

  /** Bot/quy tắc chuyển nhân viên. */
  async handoff(conversationId: string, reason: string) {
    const c = await this.prisma.$transaction(async (tx) => {
      const conv = await this.lock(tx, conversationId);
      // Không huỷ tin bot đã xếp hàng trước đó (thường là lời báo chuyển nhân viên); chỉ dừng AI đang chạy.
      await tx.aiTask.updateMany({ where: { conversationId: conv.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', reason: `Chuyển nhân viên: ${reason}` } });
      return tx.conversation.update({
        where: { id: conv.id },
        data: {
          botPausedAt: conv.botPausedAt ?? new Date(),
          botPausedReason: `Chuyển nhân viên: ${reason}`,
          handoffAt: new Date(),
          handoffReason: reason,
          status: conv.status === 'NEW' || conv.status === 'RESOLVED' ? (conv.assigneeId ? 'OPEN' : 'NEW') : undefined,
        },
      });
    });
    this.emit(c, 'conversation.handoff', { reason });
    this.emit(c, 'conversation.updated');
    return c;
  }

  async assign(workspaceId: string, conversationId: string, toUserId: string | null, actorId: string | null) {
    if (toUserId) {
      const m = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: toUserId } } });
      if (!m || m.role === 'VIEWER') throw new AppError('INVALID_ASSIGNEE', 'Người được giao phải là thành viên có quyền xử lý hội thoại');
    }
    const before = await this.prisma.conversation.findFirstOrThrow({ where: { id: conversationId, workspaceId } });
    const c = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { assigneeId: toUserId, status: before.status === 'NEW' && toUserId ? 'OPEN' : undefined },
    });
    await this.prisma.assignmentEvent.create({ data: { workspaceId, conversationId, fromUserId: before.assigneeId, toUserId, actorId } });
    this.emit(c, 'conversation.updated');
    if (toUserId) this.realtime.emit([`user:${toUserId}`], 'conversation.assigned', { conversationId });
    return c;
  }

  async setStatus(conversationId: string, status: ConversationStatus) {
    const c = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status, resolvedAt: status === 'RESOLVED' ? new Date() : null, unreadCount: status === 'RESOLVED' ? 0 : undefined },
    });
    this.emit(c, 'conversation.updated');
    return c;
  }

  async setBotMode(conversationId: string, mode: BotMode | null) {
    const c = await this.prisma.conversation.update({ where: { id: conversationId }, data: { botMode: mode } });
    this.emit(c, 'conversation.updated');
    return c;
  }

  private emit(c: Conversation, event: string, extra: Record<string, unknown> = {}) {
    this.realtime.emit(this.realtime.conversationRooms(c), event, { conversationId: c.id, channelId: c.channelId, ...extra });
  }
}
