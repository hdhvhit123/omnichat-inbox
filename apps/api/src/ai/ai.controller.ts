import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../auth/access.service';
import { ADMIN_ROLES, Roles, WRITE_ROLES, Ws, WorkspaceCtx } from '../auth/context';
import { encrypt } from '../common/crypto';
import { AppError, notFound } from '../common/errors';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { OutboxService } from '../outbox/outbox.service';
import { AuditService } from '../admin/audit.service';
import { serializeMessage } from '../inbox/serializers';
import { AiService } from './ai.service';
import { KnowledgeService } from './knowledge.service';

const SettingsDto = z.object({
  provider: z.enum(['mock', 'anthropic', 'openai']),
  model: z.string().min(1).max(100),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(10).max(500).optional(), // chỉ ghi, không bao giờ trả về
  clearApiKey: z.boolean().optional(),
  maxOutputTokens: z.number().int().min(50).max(4000),
  dailyBudgetUsd: z.number().min(0).max(10000),
  monthlyBudgetUsd: z.number().min(0).max(100000),
  inputPricePerMTok: z.number().min(0).max(1000),
  outputPricePerMTok: z.number().min(0).max(1000),
  handoffKeywords: z.array(z.string().max(50)).max(100).default([]),
});

const DocDto = z.object({ title: z.string().min(1).max(200), sourceType: z.enum(['FAQ', 'TEXT', 'PDF', 'DOCX']), rawText: z.string().max(200_000).optional(), fileId: z.string().optional(), groupId: z.string().optional() });

@Controller()
export class AiController {
  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private knowledge: KnowledgeService,
    private access: AccessService,
    private outbox: OutboxService,
    private queue: QueueService,
    private audit: AuditService,
  ) {}

  // ---- Tác vụ AI trong hội thoại ----

  @Get('conversations/:id/ai-tasks')
  async tasks(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    await this.access.getConversation(ws, id);
    const items = await this.prisma.aiTask.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'desc' }, take: 10 });
    return { items: items.map((t) => ({ ...t, costUsd: Number(t.costUsd) })) };
  }

  /** Nhân viên yêu cầu AI soạn nháp cho tin khách gần nhất (chế độ Trợ lý). */
  @Roles(...WRITE_ROLES)
  @Post('conversations/:id/ai-suggest')
  async suggest(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    await this.access.getConversation(ws, id);
    const last = await this.prisma.message.findFirst({ where: { conversationId: id, direction: 'INBOUND' }, orderBy: { sentAt: 'desc' } });
    if (!last) throw new AppError('NO_INBOUND', 'Chưa có tin nhắn của khách để soạn trả lời');
    const existing = await this.prisma.aiTask.findUnique({ where: { triggerMessageId: last.id } });
    if (existing && !['CANCELLED', 'FAILED', 'HANDOFF'].includes(existing.status)) return { task: existing };
    if (existing) await this.prisma.aiTask.delete({ where: { id: existing.id } });
    const task = await this.prisma.aiTask.create({ data: { workspaceId: ws.workspaceId, conversationId: id, triggerMessageId: last.id, mode: 'ASSIST' } });
    // Trợ lý theo yêu cầu: không bị chặn bởi trạng thái tạm dừng bot (không tự gửi)
    await this.ai.processAssist(task.id);
    return { task: await this.prisma.aiTask.findUnique({ where: { id: task.id } }) };
  }

  @Roles(...WRITE_ROLES)
  @Post('ai-tasks/:taskId/approve')
  async approve(@Ws() ws: WorkspaceCtx, @Param('taskId') taskId: string, @Body() body: { text?: string }) {
    const task = await this.prisma.aiTask.findFirst({ where: { id: taskId, workspaceId: ws.workspaceId } });
    if (!task) throw notFound('Bản nháp');
    await this.access.getConversation(ws, task.conversationId);
    const text = (body?.text ?? task.draftText ?? '').trim();
    if (!text) throw new AppError('EMPTY', 'Bản nháp trống');
    // Nhân viên duyệt = nhân viên gửi (tính là phản hồi của người)
    const r = await this.outbox.queueSend({ workspaceId: ws.workspaceId, conversationId: task.conversationId, requestedBy: 'AGENT', authorId: ws.userId, text, clientMsgId: `approve:${task.id}`, aiTaskId: task.id });
    if (!r.ok) throw new AppError('SEND_BLOCKED', r.reason, 422, { reasonCode: r.code });
    await this.prisma.aiTask.update({ where: { id: task.id }, data: { status: 'SENT', reason: text === task.draftText ? 'Nhân viên duyệt nguyên văn' : 'Nhân viên duyệt có chỉnh sửa' } });
    return { message: serializeMessage(r.message) };
  }

  @Roles(...WRITE_ROLES)
  @Post('ai-tasks/:taskId/discard')
  async discard(@Ws() ws: WorkspaceCtx, @Param('taskId') taskId: string) {
    const task = await this.prisma.aiTask.findFirst({ where: { id: taskId, workspaceId: ws.workspaceId } });
    if (!task) throw notFound('Bản nháp');
    await this.access.getConversation(ws, task.conversationId);
    await this.prisma.aiTask.update({ where: { id: task.id }, data: { status: 'CANCELLED', reason: 'Nhân viên bỏ bản nháp' } });
    return { ok: true };
  }

  // ---- Cấu hình AI & chi phí ----

  @Roles(...ADMIN_ROLES)
  @Get('ai/settings')
  async getSettings(@Ws() ws: WorkspaceCtx) {
    const s = await this.ai.settings(ws.workspaceId);
    const spend = await this.ai.spend(ws.workspaceId);
    return {
      settings: { ...s, apiKeyEnc: undefined, hasApiKey: !!s.apiKeyEnc, dailyBudgetUsd: Number(s.dailyBudgetUsd), monthlyBudgetUsd: Number(s.monthlyBudgetUsd), inputPricePerMTok: Number(s.inputPricePerMTok), outputPricePerMTok: Number(s.outputPricePerMTok) },
      spend: { dayUsd: spend.dayUsd, monthUsd: spend.monthUsd, dayTokens: { input: spend.day.inputTokens ?? 0, output: spend.day.outputTokens ?? 0 }, monthTokens: { input: spend.month.inputTokens ?? 0, output: spend.month.outputTokens ?? 0 } },
    };
  }

  @Roles('OWNER', 'MANAGER')
  @Put('ai/settings')
  async putSettings(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(SettingsDto, body);
    await this.ai.settings(ws.workspaceId);
    const { apiKey, clearApiKey, ...rest } = dto;
    await this.prisma.aiSettings.update({
      where: { workspaceId: ws.workspaceId },
      data: { ...rest, baseUrl: rest.baseUrl ?? null, ...(apiKey ? { apiKeyEnc: encrypt(apiKey) } : {}), ...(clearApiKey ? { apiKeyEnc: null } : {}) },
    });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'ai.settings_updated', metadata: { provider: dto.provider, model: dto.model, apiKeyChanged: !!apiKey || !!clearApiKey } });
    return this.getSettings(ws);
  }

  // ---- Kho kiến thức ----

  @Get('knowledge')
  async listDocs(@Ws() ws: WorkspaceCtx) {
    const docs = await this.prisma.knowledgeDocument.findMany({
      where: { workspaceId: ws.workspaceId },
      orderBy: [{ updatedAt: 'desc' }],
      select: { id: true, groupId: true, version: true, title: true, sourceType: true, status: true, approved: true, error: true, createdAt: true, updatedAt: true, _count: { select: { chunks: true } } },
    });
    return { items: docs };
  }

  @Get('knowledge/:id')
  async getDoc(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const doc = await this.prisma.knowledgeDocument.findFirst({ where: { id, workspaceId: ws.workspaceId }, include: { chunks: { orderBy: { ordinal: 'asc' }, select: { id: true, ordinal: true, content: true } } } });
    if (!doc) throw notFound('Tài liệu');
    return { document: doc };
  }

  @Roles(...ADMIN_ROLES)
  @Post('knowledge')
  async createDoc(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(DocDto, body);
    if ((dto.sourceType === 'PDF' || dto.sourceType === 'DOCX') && !dto.fileId) throw new AppError('VALIDATION', 'Cần tải tệp PDF/DOCX');
    if ((dto.sourceType === 'FAQ' || dto.sourceType === 'TEXT') && !dto.rawText?.trim()) throw new AppError('VALIDATION', 'Nội dung trống');
    if (dto.fileId) {
      const f = await this.prisma.fileObject.findFirst({ where: { id: dto.fileId, workspaceId: ws.workspaceId } });
      if (!f) throw notFound('Tệp');
    }
    const doc = await this.knowledge.create(ws.workspaceId, ws.userId, dto);
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'knowledge.created', targetType: 'knowledge', targetId: doc.id, metadata: { title: dto.title, version: doc.version } });
    return { document: doc };
  }

  @Roles(...ADMIN_ROLES)
  @Post('knowledge/:id/approve')
  async approveDoc(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: { approved: boolean }) {
    try {
      await this.knowledge.approve(ws.workspaceId, id, !!body.approved);
    } catch (e: any) {
      throw new AppError('APPROVE_FAILED', e.message);
    }
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: body.approved ? 'knowledge.approved' : 'knowledge.unapproved', targetType: 'knowledge', targetId: id });
    return { ok: true };
  }

  @Roles(...ADMIN_ROLES)
  @Post('knowledge/:id/reprocess')
  async reprocess(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const doc = await this.prisma.knowledgeDocument.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!doc) throw notFound('Tài liệu');
    await this.prisma.knowledgeDocument.update({ where: { id }, data: { status: 'PENDING' } });
    await this.queue.add(QUEUES.knowledge, { documentId: id }, { jobId: `kb-${id}-${Date.now()}`, attempts: 2 });
    return { ok: true };
  }

  @Roles(...ADMIN_ROLES)
  @Delete('knowledge/:id')
  async deleteDoc(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const doc = await this.prisma.knowledgeDocument.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!doc) throw notFound('Tài liệu');
    await this.prisma.knowledgeDocument.delete({ where: { id } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'knowledge.deleted', targetType: 'knowledge', targetId: id, metadata: { title: doc.title } });
    return { ok: true };
  }

  /** Thử truy xuất: xem đoạn tài liệu nào sẽ được dùng cho một câu hỏi. */
  @Post('knowledge/search')
  async search(@Ws() ws: WorkspaceCtx, @Body() body: { q: string }) {
    return { items: await this.knowledge.search(ws.workspaceId, String(body?.q ?? ''), 5) };
  }
}
