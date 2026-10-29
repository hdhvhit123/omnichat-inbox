import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AccessService } from '../auth/access.service';
import { ADMIN_ROLES, Roles, Ws, WorkspaceCtx } from '../auth/context';
import { AppError, notFound } from '../common/errors';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueName, QueueService } from '../common/queue.service';
import { AuditService } from './audit.service';

const WorkspaceDto = z.object({
  name: z.string().min(1).max(100).optional(),
  timezone: z.string().max(50).optional(),
  businessHours: z.record(z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)]))).nullable().optional(),
  retentionDays: z.number().int().min(30).max(3650).nullable().optional(),
  fbHumanAgentTagEnabled: z.boolean().optional(),
});

const PolicyDto = z.object({
  channelType: z.enum(['FACEBOOK', 'ZALO']),
  category: z.string().min(2).max(30),
  windowHours: z.number().int().min(1).max(24 * 30),
  allowedSenders: z.array(z.enum(['AGENT', 'BOT', 'RULE'])).min(1),
  effectiveFrom: z.string().datetime(),
  sourceUrl: z.string().url(),
  verificationStatus: z.enum(['VERIFIED', 'SECONDARY']),
  notes: z.string().max(1000).optional(),
});

function csv(rows: (string | number | null | undefined)[][]) {
  return '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

@Controller()
export class AdminController {
  constructor(private prisma: PrismaService, private audit: AuditService, private queue: QueueService, private access: AccessService) {}

  @Get('workspace')
  async workspace(@Ws() ws: WorkspaceCtx) {
    return { workspace: await this.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } }), role: ws.role, userId: ws.userId };
  }

  @Roles('OWNER')
  @Patch('workspace')
  async updateWorkspace(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(WorkspaceDto, body);
    const w = await this.prisma.workspace.update({ where: { id: ws.workspaceId }, data: { ...dto, businessHours: dto.businessHours === null ? undefined : dto.businessHours } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'workspace.updated', metadata: dto });
    return { workspace: w };
  }

  @Roles(...ADMIN_ROLES)
  @Get('audit-logs')
  async auditLogs(@Ws() ws: WorkspaceCtx, @Query('before') before?: string) {
    const items = await this.prisma.auditLog.findMany({ where: { workspaceId: ws.workspaceId, ...(before ? { createdAt: { lt: new Date(before) } } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    const users = await this.prisma.user.findMany({ where: { id: { in: items.map((i) => i.actorId).filter(Boolean) as string[] } }, select: { id: true, name: true, email: true } });
    return { items, users };
  }

  // ---- Độ tin cậy: webhook lỗi, tin gửi lỗi, dead-letter ----

  @Roles(...ADMIN_ROLES)
  @Get('ops/webhooks')
  async webhooks(@Ws() ws: WorkspaceCtx, @Query('status') status?: string) {
    const items = await this.prisma.webhookEvent.findMany({
      where: { workspaceId: ws.workspaceId, ...(status ? { status: status as any } : {}) },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: { id: true, provider: true, eventType: true, eventKey: true, status: true, attempts: true, error: true, receivedAt: true, processedAt: true },
    });
    const counts = await this.prisma.webhookEvent.groupBy({ by: ['status'], where: { workspaceId: ws.workspaceId }, _count: true });
    return { items, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  @Roles(...ADMIN_ROLES)
  @Post('ops/webhooks/:id/retry')
  async retryWebhook(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const ev = await this.prisma.webhookEvent.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!ev) throw notFound('Sự kiện');
    if (ev.status === 'PROCESSED') throw new AppError('ALREADY_PROCESSED', 'Sự kiện đã xử lý xong');
    await this.prisma.webhookEvent.update({ where: { id }, data: { status: 'RECEIVED', error: null } });
    await this.queue.add(QUEUES.webhook, { webhookEventId: id }, { jobId: `${id}-retry-${Date.now()}`, attempts: 3 });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'ops.webhook_retry', targetId: id });
    return { ok: true };
  }

  @Roles(...ADMIN_ROLES)
  @Get('ops/outbound')
  async outbound(@Ws() ws: WorkspaceCtx) {
    const items = await this.prisma.outboundMessage.findMany({
      where: { workspaceId: ws.workspaceId, status: { in: ['FAILED', 'UNKNOWN', 'BLOCKED', 'QUEUED', 'SENDING'] } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: { message: { select: { text: true, senderType: true, conversationId: true, errorMessage: true } } },
    });
    return { items };
  }

  @Roles(...ADMIN_ROLES)
  @Get('ops/dead-letter')
  async deadLetter() {
    const queues: QueueName[] = [QUEUES.webhook, QUEUES.outbound, QUEUES.ai, QUEUES.knowledge];
    const jobs = (await Promise.all(queues.map((q) => this.queue.failedJobs(q, 50)))).flat();
    // Chỉ hiển thị siêu dữ liệu, không lộ payload chi tiết
    return { items: jobs.map((j) => ({ id: j.id, queue: j.queue, failedReason: j.failedReason, attemptsMade: j.attemptsMade, timestamp: j.timestamp })) };
  }

  @Roles('OWNER')
  @Post('ops/dead-letter/:queue/:id/retry')
  async retryJob(@Ws() ws: WorkspaceCtx, @Param('queue') queue: QueueName, @Param('id') id: string) {
    if (!Object.values(QUEUES).includes(queue)) throw new AppError('VALIDATION', 'Hàng đợi không hợp lệ');
    await this.queue.retryFailed(queue, id);
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'ops.job_retry', metadata: { queue, id } });
    return { ok: true };
  }

  // ---- Quy tắc chính sách gửi tin (có phiên bản, ngày hiệu lực, nguồn) ----

  @Get('policies')
  async policies(@Ws() ws: WorkspaceCtx) {
    const items = await this.prisma.policyRule.findMany({ where: { OR: [{ workspaceId: null }, { workspaceId: ws.workspaceId }] }, orderBy: [{ channelType: 'asc' }, { category: 'asc' }, { version: 'desc' }] });
    return { items };
  }

  /** Tạo phiên bản quy tắc mới cho workspace (ghi đè mặc định). Chỉ Chủ sở hữu, có nhật ký. */
  @Roles('OWNER')
  @Post('policies')
  async createPolicy(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(PolicyDto, body);
    const last = await this.prisma.policyRule.findFirst({ where: { channelType: dto.channelType, category: dto.category, OR: [{ workspaceId: null }, { workspaceId: ws.workspaceId }] }, orderBy: { version: 'desc' } });
    const rule = await this.prisma.policyRule.create({
      data: { workspaceId: ws.workspaceId, ...dto, effectiveFrom: new Date(dto.effectiveFrom), version: (last?.version ?? 0) + 1, verifiedAt: new Date(), createdById: ws.userId },
    });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'policy.created', targetType: 'policy', targetId: rule.id, metadata: dto });
    return { rule };
  }

  @Roles('OWNER')
  @Post('policies/:id/deactivate')
  async deactivatePolicy(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const r = await this.prisma.policyRule.updateMany({ where: { id, workspaceId: ws.workspaceId }, data: { active: false, effectiveTo: new Date() } });
    if (!r.count) throw new AppError('FORBIDDEN', 'Chỉ vô hiệu hoá được quy tắc riêng của workspace', 403);
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'policy.deactivated', targetId: id });
    return { ok: true };
  }

  // ---- Xuất dữ liệu (trong phạm vi được phép, có nhật ký) ----

  @Roles(...ADMIN_ROLES)
  @Get('export/conversations.csv')
  async exportConversations(@Ws() ws: WorkspaceCtx, @Res() res: Response) {
    const rows = await this.prisma.conversation.findMany({
      where: this.access.conversationWhere(ws),
      include: { customer: true, channel: true },
      orderBy: { createdAt: 'desc' },
      take: 50_000,
    });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'export.conversations', metadata: { rows: rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hoi-thoai.csv"');
    res.send(csv([
      ['id', 'kenh', 'tai_khoan', 'khach_hang', 'so_dien_thoai', 'trang_thai', 'nguoi_phu_trach', 'tin_dau_tien_utc', 'tin_gan_nhat_utc'],
      ...rows.map((c) => [c.id, c.channel.type, c.channel.name, c.customer.displayName, c.customer.phone, c.status, c.assigneeId, c.firstInboundAt?.toISOString(), c.lastMessageAt?.toISOString()]),
    ]));
  }

  @Roles(...ADMIN_ROLES)
  @Get('export/messages.csv')
  async exportMessages(@Ws() ws: WorkspaceCtx, @Query('conversationId') conversationId: string, @Res() res: Response) {
    const c = await this.access.getConversation(ws, conversationId);
    const msgs = await this.prisma.message.findMany({ where: { conversationId: c.id }, orderBy: { sentAt: 'asc' } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'export.messages', targetType: 'conversation', targetId: c.id, metadata: { rows: msgs.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tin-nhan-${c.id}.csv"`);
    res.send(csv([['thoi_gian_utc', 'chieu', 'nguoi_gui', 'noi_dung', 'trang_thai'], ...msgs.map((m) => [m.sentAt.toISOString(), m.direction, m.senderType, m.text, m.status])]));
  }
}
