import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ADMIN_ROLES, Roles, Ws, WorkspaceCtx } from '../auth/context';
import { AppError, notFound } from '../common/errors';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../admin/audit.service';
import { BUILTIN_INTENTS, hasReplyAction, isOutsideBusinessHours, RuleAction, ruleMatches } from './rule-engine';

const Action = z.object({
  type: z.enum(['SEND_TEXT', 'ADD_TAG', 'ASSIGN', 'HANDOFF', 'START_LEAD_CAPTURE', 'SET_STATUS']),
  text: z.string().max(2000).optional(),
  tagName: z.string().max(50).optional(),
  userId: z.string().optional(),
  reason: z.string().max(200).optional(),
  status: z.enum(['NEW', 'OPEN', 'PENDING', 'RESOLVED']).optional(),
});
const RuleDto = z.object({
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(false),
  testMode: z.boolean().default(true),
  trigger: z.enum(['NEW_CONVERSATION', 'INBOUND_MESSAGE', 'OUTSIDE_HOURS']),
  channelTypes: z.array(z.enum(['FACEBOOK', 'ZALO'])).default([]),
  channelIds: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(10000).default(100),
  conditions: z.object({ keywords: z.array(z.string().max(100)).max(50).optional(), match: z.enum(['any', 'all']).optional(), excludeKeywords: z.array(z.string().max(100)).max(50).optional(), intents: z.array(z.string()).optional() }).default({}),
  actions: z.array(Action).min(1).max(10),
  isGreeting: z.boolean().default(false),
  cooldownSeconds: z.number().int().min(0).max(30 * 24 * 3600).default(0),
  maxRunsPerConversation: z.number().int().min(1).max(1000).nullable().default(null),
});
const TestDto = z.object({ text: z.string().max(2000), channelType: z.enum(['FACEBOOK', 'ZALO']), channelId: z.string().optional(), isNewConversation: z.boolean().default(false), at: z.string().datetime().optional() });

@Controller('rules')
export class RulesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  async list(@Ws() ws: WorkspaceCtx) {
    const rules = await this.prisma.automationRule.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
    return { items: rules, intents: Object.entries(BUILTIN_INTENTS).map(([key, v]) => ({ key, label: v.label })) };
  }

  private validate(dto: z.infer<typeof RuleDto>) {
    for (const a of dto.actions) {
      if (a.type === 'SEND_TEXT' && !a.text?.trim()) throw new AppError('VALIDATION', 'Hành động gửi tin cần nội dung');
      if (a.type === 'ADD_TAG' && !a.tagName) throw new AppError('VALIDATION', 'Hành động gắn nhãn cần tên nhãn');
      if (a.type === 'ASSIGN' && !a.userId) throw new AppError('VALIDATION', 'Hành động phân công cần chọn nhân viên');
    }
    if (dto.isGreeting && !hasReplyAction(dto.actions as RuleAction[])) throw new AppError('VALIDATION', 'Quy tắc chào cần có hành động gửi tin');
  }

  @Roles(...ADMIN_ROLES)
  @Post()
  async create(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(RuleDto, body);
    this.validate(dto);
    const rule = await this.prisma.automationRule.create({ data: { workspaceId: ws.workspaceId, ...dto, conditions: dto.conditions as Prisma.InputJsonValue, actions: dto.actions as Prisma.InputJsonValue } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'rule.created', targetType: 'rule', targetId: rule.id, metadata: { name: rule.name } });
    return { rule };
  }

  @Roles(...ADMIN_ROLES)
  @Patch(':id')
  async update(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: unknown) {
    const existing = await this.prisma.automationRule.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!existing) throw notFound('Quy tắc');
    const dto = parse(RuleDto, { ...existing, ...(body as object) });
    this.validate(dto);
    const rule = await this.prisma.automationRule.update({ where: { id }, data: { ...dto, conditions: dto.conditions as Prisma.InputJsonValue, actions: dto.actions as Prisma.InputJsonValue } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'rule.updated', targetType: 'rule', targetId: id, metadata: { enabled: rule.enabled, testMode: rule.testMode } });
    return { rule };
  }

  @Roles(...ADMIN_ROLES)
  @Delete(':id')
  async remove(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const r = await this.prisma.automationRule.deleteMany({ where: { id, workspaceId: ws.workspaceId } });
    if (!r.count) throw notFound('Quy tắc');
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'rule.deleted', targetType: 'rule', targetId: id });
    return { ok: true };
  }

  @Get(':id/executions')
  async executions(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const items = await this.prisma.ruleExecution.findMany({ where: { ruleId: id, workspaceId: ws.workspaceId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { items };
  }

  /** Thử quy tắc với một câu mẫu mà không gửi gì. */
  @Post('test')
  async test(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(TestDto, body);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId } });
    const at = dto.at ? new Date(dto.at) : new Date();
    const ctx = { text: dto.text, channelType: dto.channelType, channelId: dto.channelId ?? '', isNewConversation: dto.isNewConversation, outsideHours: isOutsideBusinessHours(workspace.businessHours, workspace.timezone, at) };
    const rules = await this.prisma.automationRule.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
    let replied = false;
    const results = rules.map((r) => {
      const m = ruleMatches(r, ctx);
      const replies = hasReplyAction(r.actions as unknown as RuleAction[]);
      let outcome = m.matched ? (r.enabled ? (r.testMode ? 'Chế độ thử (chỉ ghi lịch sử)' : 'Sẽ chạy') : 'Khớp nhưng đang tắt') : 'Không khớp';
      if (m.matched && r.enabled && !r.testMode && replies) {
        if (replied) outcome = 'Bỏ qua: đã có quy tắc ưu tiên cao hơn trả lời';
        else replied = true;
      }
      return { ruleId: r.id, name: r.name, matched: m.matched, why: m.why, outcome };
    });
    return { outsideHours: ctx.outsideHours, results };
  }
}
