import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ConversationStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../auth/access.service';
import { ADMIN_ROLES, Roles, WRITE_ROLES, Ws, WorkspaceCtx } from '../auth/context';
import { AppError, notFound } from '../common/errors';
import { normalizeVi } from '../common/text';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { AuditService } from '../admin/audit.service';
import { ConversationOpsService } from './conversation-ops.service';
import { serializeMessage } from './serializers';

const ListQuery = z.object({
  status: z.enum(['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'ACTIVE']).optional(),
  channelType: z.enum(['FACEBOOK', 'ZALO']).optional(),
  channelId: z.string().optional(),
  assignee: z.string().optional(), // userId | me | none
  tagId: z.string().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
});

const SendDto = z.object({ text: z.string().max(5000).optional(), fileId: z.string().optional(), clientMsgId: z.string().min(8).max(100) });
const NoteDto = z.object({ body: z.string().min(1).max(5000) });

@Controller('conversations')
export class ConversationsController {
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private outbox: OutboxService,
    private ops: ConversationOpsService,
    private realtime: RealtimePublisher,
    private audit: AuditService,
  ) {}

  @Get()
  async list(@Ws() ws: WorkspaceCtx, @Query() query: unknown) {
    const q = parse(ListQuery, query);
    const and: Prisma.ConversationWhereInput[] = [this.access.conversationWhere(ws)];
    if (q.status === 'ACTIVE') and.push({ status: { in: ['NEW', 'OPEN', 'PENDING'] } });
    else if (q.status) and.push({ status: q.status as ConversationStatus });
    if (q.channelType) and.push({ channel: { type: q.channelType } });
    if (q.channelId) and.push({ channelId: q.channelId });
    if (q.assignee === 'me') and.push({ assigneeId: ws.userId });
    else if (q.assignee === 'none') and.push({ assigneeId: null });
    else if (q.assignee) and.push({ assigneeId: q.assignee });
    if (q.tagId) and.push({ tags: { some: { tagId: q.tagId } } });
    if (q.q) {
      const n = normalizeVi(q.q);
      and.push({
        OR: [
          { customer: { searchText: { contains: n } } },
          { customer: { phone: { contains: q.q.replace(/\s/g, '') } } },
          { messages: { some: { searchText: { contains: n } } } },
        ],
      });
    }
    const rows = await this.prisma.conversation.findMany({
      where: { AND: and },
      include: {
        customer: { select: { id: true, displayName: true, avatarUrl: true, phone: true } },
        channel: { select: { id: true, type: true, name: true, isSimulated: true } },
        tags: { include: { tag: true } },
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map((c) => ({
      id: c.id,
      status: c.status,
      assigneeId: c.assigneeId,
      botMode: c.botMode,
      botPaused: !!c.botPausedAt,
      lastMessageAt: c.lastMessageAt,
      lastInboundAt: c.lastInboundAt,
      lastMessagePreview: c.lastMessagePreview,
      unreadCount: c.unreadCount,
      handoffAt: c.handoffAt,
      customer: c.customer,
      channel: c.channel,
      tags: c.tags.map((t) => t.tag),
    }));
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  @Get('unhandled-count')
  async unhandled(@Ws() ws: WorkspaceCtx) {
    const where = { AND: [this.access.conversationWhere(ws), { status: { in: ['NEW', 'OPEN'] as ConversationStatus[] } }, { unreadCount: { gt: 0 } }] };
    return { count: await this.prisma.conversation.count({ where }) };
  }

  @Get(':id')
  async get(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    await this.access.getConversation(ws, id);
    const c = await this.prisma.conversation.findUniqueOrThrow({
      where: { id },
      include: {
        customer: { include: { identities: { include: { channel: { select: { id: true, type: true, name: true } } } }, tags: { include: { tag: true } } } },
        identity: true,
        channel: { select: { id: true, type: true, name: true, status: true, isSimulated: true, botMode: true } },
        tags: { include: { tag: true } },
      },
    });
    return {
      ...c,
      deliveredWatermark: undefined,
      readWatermark: undefined,
      tags: c.tags.map((t) => t.tag),
      customer: { ...c.customer, tags: c.customer.tags.map((t) => t.tag), searchText: undefined },
      effectiveBotMode: c.botMode ?? c.channel.botMode,
    };
  }

  /** Dòng thời gian: tin nhắn + ghi chú nội bộ, phân trang lùi theo thời gian. */
  @Get(':id/timeline')
  async timeline(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Query('before') before?: string, @Query('limit') limitRaw?: string) {
    await this.access.getConversation(ws, id);
    const limit = Math.min(Number(limitRaw) || 40, 100);
    const beforeDate = before ? new Date(before) : new Date(Date.now() + 60_000);
    const [messages, notes] = await Promise.all([
      this.prisma.message.findMany({ where: { conversationId: id, sentAt: { lt: beforeDate } }, orderBy: { sentAt: 'desc' }, take: limit }),
      this.prisma.internalNote.findMany({ where: { conversationId: id, createdAt: { lt: beforeDate } }, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    const items = [
      ...messages.map((m) => ({ kind: 'message' as const, at: m.sentAt.toISOString(), message: serializeMessage(m) })),
      ...notes.map((n) => ({ kind: 'note' as const, at: n.createdAt.toISOString(), note: n })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
    const hasMore = messages.length === limit || notes.length === limit;
    return { items: items.reverse(), nextBefore: hasMore && items.length ? items[0].at : null };
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/messages')
  async send(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(SendDto, body);
    await this.access.getConversation(ws, id);
    if (!dto.text?.trim() && !dto.fileId) throw new AppError('EMPTY', 'Tin nhắn trống');
    if (dto.text?.trim() && dto.fileId) throw new AppError('ONE_PART', 'Gửi văn bản và tệp thành hai tin riêng');
    const r = await this.outbox.queueSend({ workspaceId: ws.workspaceId, conversationId: id, requestedBy: 'AGENT', authorId: ws.userId, text: dto.text, fileId: dto.fileId, clientMsgId: `ui:${ws.userId}:${dto.clientMsgId}` });
    if (!r.ok) throw new AppError('SEND_BLOCKED', r.reason, 422, { reasonCode: r.code });
    return { message: serializeMessage(r.message), duplicate: r.duplicate };
  }

  /** Gửi lại tin thất bại / chưa xác định (tạo tin mới). Với UNKNOWN cần xác nhận vì có thể trùng. */
  @Roles(...WRITE_ROLES)
  @Post(':id/messages/:messageId/resend')
  async resend(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Param('messageId') messageId: string, @Body() body: { confirmPossibleDuplicate?: boolean }) {
    await this.access.getConversation(ws, id);
    const m = await this.prisma.message.findFirst({ where: { id: messageId, conversationId: id, direction: 'OUTBOUND' } });
    if (!m) throw notFound('Tin nhắn');
    if (!['FAILED', 'UNKNOWN', 'BLOCKED', 'CANCELLED'].includes(m.status)) throw new AppError('NOT_RESENDABLE', 'Chỉ gửi lại được tin thất bại, bị chặn hoặc chưa xác định');
    if (m.status === 'UNKNOWN' && !body?.confirmPossibleDuplicate) {
      throw new AppError('CONFIRM_DUPLICATE', 'Tin này có thể đã tới khách. Xác nhận nếu vẫn muốn gửi lại (khách có thể nhận 2 lần).', 409);
    }
    const fileId = (m.attachments as any[] | null)?.[0]?.fileId ?? null;
    const r = await this.outbox.queueSend({ workspaceId: ws.workspaceId, conversationId: id, requestedBy: 'AGENT', authorId: ws.userId, text: m.text, fileId, clientMsgId: `resend:${m.id}:${Date.now()}` });
    if (!r.ok) throw new AppError('SEND_BLOCKED', r.reason, 422, { reasonCode: r.code });
    return { message: serializeMessage(r.message) };
  }

  /** Ghi chú nội bộ: lưu bảng riêng, KHÔNG BAO GIỜ gửi ra kênh. */
  @Roles(...WRITE_ROLES)
  @Post(':id/notes')
  async note(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(NoteDto, body);
    const c = await this.access.getConversation(ws, id);
    const note = await this.prisma.internalNote.create({ data: { workspaceId: ws.workspaceId, conversationId: id, authorId: ws.userId, body: dto.body } });
    this.realtime.emit(this.realtime.conversationRooms(c), 'note.created', { conversationId: id, note });
    return { note };
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/assign')
  async assign(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: { userId: string | null }) {
    await this.access.getConversation(ws, id);
    // Nhân viên chỉ tự nhận hoặc nhả hội thoại; phân công người khác cần Quản lý trở lên
    if (ws.role === 'AGENT' && body.userId && body.userId !== ws.userId) throw new AppError('FORBIDDEN', 'Chỉ Quản lý mới phân công cho người khác', 403);
    const c = await this.ops.assign(ws.workspaceId, id, body.userId ?? null, ws.userId);
    return { conversation: c };
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/status')
  async status(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: { status: ConversationStatus }) {
    await this.access.getConversation(ws, id);
    if (!['NEW', 'OPEN', 'PENDING', 'RESOLVED'].includes(body.status)) throw new AppError('VALIDATION', 'Trạng thái không hợp lệ');
    return { conversation: await this.ops.setStatus(id, body.status) };
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/takeover')
  async takeover(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    await this.access.getConversation(ws, id);
    return { conversation: await this.ops.takeover(id, ws.userId) };
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/resume-bot')
  async resumeBot(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    await this.access.getConversation(ws, id);
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'conversation.resume_bot', targetType: 'conversation', targetId: id });
    return { conversation: await this.ops.resumeBot(id) };
  }

  @Roles(...ADMIN_ROLES)
  @Patch(':id/bot-mode')
  async botMode(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: { mode: 'MANUAL' | 'ASSIST' | 'AUTO' | null }) {
    await this.access.getConversation(ws, id);
    if (body.mode !== null && !['MANUAL', 'ASSIST', 'AUTO'].includes(body.mode)) throw new AppError('VALIDATION', 'Chế độ không hợp lệ');
    return { conversation: await this.ops.setBotMode(id, body.mode) };
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/read')
  async markRead(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    await this.access.getConversation(ws, id);
    await this.prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } });
    return { ok: true };
  }

  @Roles(...WRITE_ROLES)
  @Post(':id/tags')
  async addTag(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: { tagId?: string; name?: string }) {
    await this.access.getConversation(ws, id);
    let tagId = body.tagId;
    if (!tagId && body.name) {
      if (ws.role === 'AGENT') throw new AppError('FORBIDDEN', 'Nhân viên chỉ gắn nhãn có sẵn', 403);
      tagId = (await this.prisma.tag.upsert({ where: { workspaceId_name: { workspaceId: ws.workspaceId, name: body.name.trim().slice(0, 50) } }, create: { workspaceId: ws.workspaceId, name: body.name.trim().slice(0, 50) }, update: {} })).id;
    }
    const tag = await this.prisma.tag.findFirst({ where: { id: tagId, workspaceId: ws.workspaceId } });
    if (!tag) throw notFound('Nhãn');
    await this.prisma.conversationTag.upsert({ where: { conversationId_tagId: { conversationId: id, tagId: tag.id } }, create: { conversationId: id, tagId: tag.id }, update: {} });
    return { tag };
  }

  @Roles(...WRITE_ROLES)
  @Delete(':id/tags/:tagId')
  async removeTag(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Param('tagId') tagId: string) {
    await this.access.getConversation(ws, id);
    await this.prisma.conversationTag.deleteMany({ where: { conversationId: id, tagId } });
    return { ok: true };
  }

  /** Báo đang soạn tin (hiển thị cho đồng nghiệp để tránh trả lời trùng). */
  @Roles(...WRITE_ROLES)
  @Post(':id/typing')
  async typing(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const c = await this.access.getConversation(ws, id);
    this.realtime.emit(this.realtime.conversationRooms(c), 'agent.typing', { conversationId: id, userId: ws.userId, at: Date.now() });
    return { ok: true };
  }
}
