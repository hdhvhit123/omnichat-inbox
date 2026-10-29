import { Injectable, Logger } from '@nestjs/common';
import { AutomationRule, Conversation, Message, Prisma } from '@prisma/client';
import { normalizeVnPhone } from '../common/text';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { ConversationOpsService } from '../inbox/conversation-ops.service';
import { OutboxService } from '../outbox/outbox.service';
import { hasReplyAction, isOutsideBusinessHours, RuleAction, ruleMatches } from './rule-engine';

// Chống vòng lặp: tối đa N tin tự động trong 10 phút cho một hội thoại
const MAX_AUTO_PER_10_MIN = 5;

interface LeadFlow {
  type: 'lead';
  step: 'name' | 'phone' | 'need';
  data: { name?: string; phone?: string; need?: string };
  phoneTries?: number;
}

/**
 * Chạy sau khi lưu tin đến của khách (không bao giờ chạy cho echo hay tin bot):
 * 1) quy trình thu thập thông tin đang dở → 2) quy tắc tự động → 3) AI.
 * Mỗi bước dùng khoá idempotent theo messageId nên chạy lại không gửi trùng.
 */
@Injectable()
export class AutomationService {
  private readonly log = new Logger('Automation');

  constructor(
    private prisma: PrismaService,
    private outbox: OutboxService,
    private ops: ConversationOpsService,
    private queue: QueueService,
  ) {}

  async onInbound(messageId: string, opts: { isNewConversation: boolean }) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.direction !== 'INBOUND' || message.senderType !== 'CUSTOMER') return;
    const conversation = await this.prisma.conversation.findUniqueOrThrow({ where: { id: message.conversationId }, include: { channel: { include: { workspace: true } } } });
    if (conversation.botPausedAt) return; // nhân viên đang xử lý

    const recentAuto = await this.prisma.message.count({
      where: { conversationId: conversation.id, direction: 'OUTBOUND', senderType: 'BOT', createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    });
    if (recentAuto >= MAX_AUTO_PER_10_MIN) {
      await this.ops.handoff(conversation.id, 'Quá nhiều tin tự động trong thời gian ngắn (chống vòng lặp)');
      return;
    }

    if (await this.continueLeadFlow(conversation, message)) return;

    const { replied, handoff } = await this.runRules(conversation, message, opts.isNewConversation);
    if (replied || handoff) return;

    const mode = conversation.botMode ?? conversation.channel.botMode;
    if (mode === 'MANUAL') return;
    try {
      const task = await this.prisma.aiTask.create({ data: { workspaceId: conversation.workspaceId, conversationId: conversation.id, triggerMessageId: message.id, mode } });
      await this.queue.add(QUEUES.ai, { aiTaskId: task.id }, { jobId: `ai-${task.id}`, attempts: 2 });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; // đã tạo cho tin này
    }
  }

  async runRules(conversation: Conversation & { channel: { type: any; workspace: { businessHours: any; timezone: string } } }, message: Message, isNew: boolean) {
    const rules = await this.prisma.automationRule.findMany({ where: { workspaceId: conversation.workspaceId, enabled: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
    const ctx = {
      text: message.text,
      channelType: conversation.channel.type,
      channelId: conversation.channelId,
      isNewConversation: isNew,
      outsideHours: isOutsideBusinessHours(conversation.channel.workspace.businessHours, conversation.channel.workspace.timezone, message.sentAt),
    };
    let replied = false;
    let handoff = false;
    let greeted = !!conversation.greetedAt;

    for (const rule of rules) {
      const m = ruleMatches(rule, ctx);
      if (!m.matched) continue;
      // HANDOFF luôn chạy sau cùng để lời nhắn trả lời được xếp hàng trước khi dừng bot
      const actions = [...((rule.actions ?? []) as unknown as RuleAction[])].sort((a, b) => Number(a.type === 'HANDOFF') - Number(b.type === 'HANDOFF'));
      const replies = hasReplyAction(actions);
      const skip = (detail: string) => this.record(rule, conversation.id, message.id, 'SKIPPED', detail);

      if (rule.isGreeting && greeted) { await skip('Hội thoại đã được chào trước đó'); continue; }
      if (replies && replied) { await skip('Đã có quy tắc ưu tiên cao hơn trả lời tin này'); continue; }
      if (rule.cooldownSeconds > 0) {
        const last = await this.prisma.ruleExecution.findFirst({ where: { ruleId: rule.id, conversationId: conversation.id, status: 'EXECUTED' }, orderBy: { createdAt: 'desc' } });
        if (last && Date.now() - last.createdAt.getTime() < rule.cooldownSeconds * 1000) { await skip('Đang trong khoảng nghỉ giữa các lần kích hoạt'); continue; }
      }
      if (rule.maxRunsPerConversation != null) {
        const runs = await this.prisma.ruleExecution.count({ where: { ruleId: rule.id, conversationId: conversation.id, status: 'EXECUTED' } });
        if (runs >= rule.maxRunsPerConversation) { await skip('Đã đạt giới hạn số lần chạy trên hội thoại'); continue; }
      }
      if (rule.testMode) {
        await this.record(rule, conversation.id, message.id, 'DRY_RUN', `Chế độ thử: ${m.why}. Hành động: ${actions.map((a) => a.type).join(', ')}`);
        continue;
      }
      const first = await this.record(rule, conversation.id, message.id, 'EXECUTED', m.why);
      if (!first) {
        // Đã chạy cho tin này (job chạy lại) → không thực hiện lại hành động
        if (replies) replied = true;
        continue;
      }
      const errors: string[] = [];
      for (const a of actions) {
        const err = await this.execute(rule, a, conversation, message);
        if (err) errors.push(err);
        if (a.type === 'HANDOFF') handoff = true;
      }
      if (errors.length) {
        await this.prisma.ruleExecution.update({ where: { ruleId_messageId: { ruleId: rule.id, messageId: message.id } }, data: { status: 'FAILED', detail: errors.join('; ') } });
      }
      if (rule.isGreeting) {
        greeted = true;
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: { greetedAt: new Date() } });
      }
      // Lời chào không chặn câu trả lời nội dung (quy tắc khác hoặc AI) cho cùng tin nhắn
      if (replies && !rule.isGreeting) replied = true;
      if (handoff) break;
    }
    return { replied, handoff };
  }

  /** Ghi lịch sử; trả false nếu đã có bản ghi cho (rule, message). */
  private async record(rule: AutomationRule, conversationId: string, messageId: string, status: 'EXECUTED' | 'DRY_RUN' | 'SKIPPED' | 'FAILED', detail: string) {
    try {
      await this.prisma.ruleExecution.create({ data: { workspaceId: rule.workspaceId, ruleId: rule.id, conversationId, messageId, status, detail } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  private async execute(rule: AutomationRule, a: RuleAction, conversation: Conversation, message: Message): Promise<string | null> {
    switch (a.type) {
      case 'SEND_TEXT': {
        if (!a.text?.trim()) return 'Nội dung trả lời trống';
        const r = await this.outbox.queueSend({ workspaceId: conversation.workspaceId, conversationId: conversation.id, requestedBy: 'RULE', text: a.text, clientMsgId: `rule:${rule.id}:${message.id}`, ruleId: rule.id });
        return r.ok ? null : `Không gửi được: ${r.reason}`;
      }
      case 'ADD_TAG': {
        if (!a.tagName) return 'Thiếu tên nhãn';
        const tag = await this.prisma.tag.upsert({ where: { workspaceId_name: { workspaceId: conversation.workspaceId, name: a.tagName } }, create: { workspaceId: conversation.workspaceId, name: a.tagName }, update: {} });
        await this.prisma.conversationTag.upsert({ where: { conversationId_tagId: { conversationId: conversation.id, tagId: tag.id } }, create: { conversationId: conversation.id, tagId: tag.id }, update: {} });
        return null;
      }
      case 'ASSIGN':
        if (!a.userId) return 'Thiếu người được giao';
        try {
          await this.ops.assign(conversation.workspaceId, conversation.id, a.userId, null);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      case 'HANDOFF':
        await this.ops.handoff(conversation.id, a.reason ?? `Theo quy tắc "${rule.name}"`);
        return null;
      case 'SET_STATUS':
        if (a.status) await this.ops.setStatus(conversation.id, a.status);
        return null;
      case 'START_LEAD_CAPTURE': {
        const flow: LeadFlow = { type: 'lead', step: 'name', data: {} };
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: { flowState: flow as unknown as Prisma.InputJsonValue } });
        const r = await this.outbox.queueSend({
          workspaceId: conversation.workspaceId, conversationId: conversation.id, requestedBy: 'RULE',
          text: a.text?.trim() || 'Dạ, để nhân viên hỗ trợ tốt hơn, anh/chị vui lòng cho em xin tên ạ?',
          clientMsgId: `lead:${message.id}`, ruleId: rule.id,
        });
        return r.ok ? null : `Không gửi được: ${r.reason}`;
      }
    }
    return null;
  }

  /** Thu thập lần lượt tên → số điện thoại → nhu cầu, rồi chuyển nhân viên. */
  private async continueLeadFlow(conversation: Conversation, message: Message): Promise<boolean> {
    const flow = conversation.flowState as unknown as LeadFlow | null;
    if (!flow || flow.type !== 'lead') return false;
    const text = (message.text ?? '').trim();
    const send = (t: string) =>
      this.outbox.queueSend({ workspaceId: conversation.workspaceId, conversationId: conversation.id, requestedBy: 'RULE', text: t, clientMsgId: `lead:${message.id}` });
    const save = (f: LeadFlow | null) => this.prisma.conversation.update({ where: { id: conversation.id }, data: { flowState: f ? (f as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });

    if (!text) {
      await send('Dạ, anh/chị vui lòng trả lời bằng tin nhắn văn bản giúp em ạ.');
      return true;
    }
    if (flow.step === 'name') {
      flow.data.name = text.slice(0, 100);
      flow.step = 'phone';
      await save(flow);
      await send(`Cảm ơn ${flow.data.name}. Anh/chị cho em xin số điện thoại liên hệ ạ?`);
      return true;
    }
    if (flow.step === 'phone') {
      const phone = normalizeVnPhone(text);
      if (!phone) {
        flow.phoneTries = (flow.phoneTries ?? 0) + 1;
        if (flow.phoneTries >= 2) {
          await save(null);
          await this.ops.handoff(conversation.id, 'Không thu thập được số điện thoại hợp lệ');
          return true;
        }
        await save(flow);
        await send('Số điện thoại chưa đúng định dạng. Anh/chị kiểm tra lại giúp em (ví dụ 0901234567) ạ.');
        return true;
      }
      flow.data.phone = phone;
      flow.step = 'need';
      await save(flow);
      await send('Dạ, anh/chị đang cần hỗ trợ hoặc quan tâm sản phẩm/dịch vụ nào ạ?');
      return true;
    }
    flow.data.need = text.slice(0, 1000);
    await save(null);
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: conversation.customerId } });
    await this.prisma.customer.update({ where: { id: customer.id }, data: { phone: customer.phone ?? flow.data.phone } });
    await this.prisma.internalNote.create({
      data: {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        authorId: 'system',
        body: `Thông tin khách cung cấp qua bot:\n• Tên: ${flow.data.name}\n• SĐT: ${flow.data.phone}\n• Nhu cầu: ${flow.data.need}`,
      },
    });
    await send('Em đã ghi nhận thông tin. Nhân viên sẽ liên hệ anh/chị sớm nhất ạ!');
    await this.ops.handoff(conversation.id, 'Khách đã để lại thông tin liên hệ');
    return true;
  }
}
