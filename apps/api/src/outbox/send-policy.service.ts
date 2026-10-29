import { Injectable } from '@nestjs/common';
import { Channel, ChannelType, Conversation, CustomerIdentity, OutboundRequester, PolicyRule, Workspace } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CHANNEL_CAPABILITIES } from '../channels/adapters/types';

export interface SendCheckInput {
  workspace: Workspace;
  channel: Channel;
  conversation: Conversation;
  identity: CustomerIdentity;
  requestedBy: OutboundRequester;
  text?: string | null;
  attachment?: { type: 'image' | 'file' | 'audio' | 'video'; mime: string; size: number } | null;
  now?: Date;
}

export type SendDecision =
  | { allowed: true; sendParams: { messagingType?: 'RESPONSE' | 'MESSAGE_TAG'; tag?: string; zaloType?: 'cs' }; policy: { id: string; category: string; version: number } }
  | { allowed: false; code: string; reason: string };

const deny = (code: string, reason: string): SendDecision => ({ allowed: false, code, reason });

/**
 * Dịch vụ kiểm tra điều kiện gửi tập trung — áp dụng cho nhân viên, chatbot, quy tắc và tác vụ nền.
 * Không tự đổi loại tin hoặc gắn tag để lách hạn chế: chỉ chọn tag khi quy tắc chính sách cho phép
 * đúng loại người gửi và workspace đã bật (đã được nền tảng duyệt).
 */
@Injectable()
export class SendPolicyService {
  constructor(private prisma: PrismaService) {}

  async activeRules(workspaceId: string, channelType: ChannelType, now = new Date()): Promise<PolicyRule[]> {
    const rows = await this.prisma.policyRule.findMany({
      where: {
        channelType,
        active: true,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        AND: [{ OR: [{ workspaceId }, { workspaceId: null }] }],
      },
      orderBy: [{ version: 'desc' }],
    });
    // Mỗi category: ưu tiên ghi đè của workspace, rồi phiên bản mới nhất
    const byCat = new Map<string, PolicyRule>();
    for (const r of rows.sort((a, b) => Number(!!b.workspaceId) - Number(!!a.workspaceId) || b.version - a.version)) {
      if (!byCat.has(r.category)) byCat.set(r.category, r);
    }
    return [...byCat.values()];
  }

  async check(input: SendCheckInput): Promise<SendDecision> {
    const { workspace, channel, conversation, identity, requestedBy } = input;
    const now = input.now ?? new Date();

    // 1. Tách biệt demo / thật
    if (channel.isSimulated !== workspace.isDemo) return deny('DEMO_ISOLATION', 'Kênh mô phỏng chỉ dùng trong workspace demo và ngược lại.');
    // 2. Quyền kết nối
    if (channel.status !== 'CONNECTED') {
      const why = channel.status === 'ERROR' ? `Kênh đang lỗi: ${channel.lastError ?? 'cần kiểm tra kết nối'}` : channel.status === 'DISCONNECTED' ? 'Kênh đã bị ngắt kết nối.' : 'Kênh chưa được xác minh kết nối.';
      return deny('CHANNEL_NOT_CONNECTED', `${why} Vui lòng vào trang Kết nối kênh để kiểm tra hoặc cấp quyền lại.`);
    }
    // 3. Loại tin & giới hạn nội dung theo khả năng thực tế của kênh
    const caps = CHANNEL_CAPABILITIES[channel.type];
    const text = input.text?.trim() ?? '';
    if (!text && !input.attachment) return deny('EMPTY', 'Tin nhắn trống.');
    if (text.length > caps.maxTextLength) return deny('TEXT_TOO_LONG', `Nội dung vượt quá ${caps.maxTextLength} ký tự cho phép của kênh.`);
    if (input.attachment) {
      const a = input.attachment;
      if (!(caps.attachments as readonly string[]).includes(a.type)) return deny('ATTACHMENT_UNSUPPORTED', `Kênh ${label(channel.type)} không hỗ trợ gửi loại tệp này qua API.`);
      if (channel.type === 'ZALO' && a.type === 'image') {
        const z = CHANNEL_CAPABILITIES.ZALO;
        if (!(z.imageMimes as readonly string[]).includes(a.mime)) return deny('ATTACHMENT_UNSUPPORTED', 'Zalo chỉ nhận ảnh JPG hoặc PNG.');
        if (a.size > z.imageMaxMb * 1024 * 1024) return deny('ATTACHMENT_TOO_LARGE', `Ảnh gửi qua Zalo tối đa ${z.imageMaxMb}MB.`);
      }
      if (a.size > caps.maxAttachmentMb * 1024 * 1024) return deny('ATTACHMENT_TOO_LARGE', `Tệp vượt quá ${caps.maxAttachmentMb}MB cho phép của kênh.`);
    }
    // 4. Trạng thái người nhận
    if (!identity.canReceive) return deny('RECIPIENT_UNAVAILABLE', `Người nhận hiện không thể nhận tin${identity.cannotReceiveReason ? `: ${identity.cannotReceiveReason}` : ''}.`);
    // 5. Tương tác hợp lệ gần nhất (MVP chỉ trả lời hội thoại do khách khởi tạo)
    if (!conversation.lastInboundAt) return deny('NO_CUSTOMER_INTERACTION', 'Khách chưa nhắn tin cho trang. Phiên bản này chỉ hỗ trợ trả lời hội thoại do khách khởi tạo.');

    // 6. Cửa sổ gửi tin theo quy tắc chính sách đang hiệu lực
    const rules = await this.activeRules(workspace.id, channel.type, now);
    const hours = (now.getTime() - conversation.lastInboundAt.getTime()) / 3600_000;
    const inWindow = (r?: PolicyRule) => !!r && hours <= r.windowHours && r.allowedSenders.includes(requestedBy);

    if (channel.type === 'FACEBOOK') {
      const standard = rules.find((r) => r.category === 'RESPONSE');
      if (inWindow(standard)) return { allowed: true, sendParams: { messagingType: 'RESPONSE' }, policy: pick(standard!) };
      const human = rules.find((r) => r.category === 'HUMAN_AGENT');
      if (requestedBy === 'AGENT' && workspace.fbHumanAgentTagEnabled && inWindow(human)) {
        return { allowed: true, sendParams: { messagingType: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }, policy: pick(human!) };
      }
      if (!standard) return deny('NO_POLICY', 'Chưa có quy tắc chính sách hiệu lực cho Facebook. Quản trị viên cần cấu hình.');
      const extra = requestedBy === 'AGENT'
        ? workspace.fbHumanAgentTagEnabled
          ? ` Đã quá cả thời hạn ${human?.windowHours ?? 168} giờ cho nhân viên (tag HUMAN_AGENT).`
          : ' Nếu trang đã được Meta duyệt tính năng Human Agent, chủ sở hữu có thể bật trong Cài đặt để nhân viên trả lời trong 7 ngày.'
        : '';
      return deny('WINDOW_EXPIRED', `Đã quá ${standard.windowHours} giờ kể từ tin nhắn gần nhất của khách nên không thể gửi tin thường qua Messenger.${extra} Bản nháp được giữ lại.`);
    }

    const cs = rules.find((r) => r.category === 'CS');
    if (!cs) return deny('NO_POLICY', 'Chưa có quy tắc chính sách hiệu lực cho Zalo OA. Quản trị viên cần cấu hình.');
    if (inWindow(cs)) return { allowed: true, sendParams: { zaloType: 'cs' }, policy: pick(cs) };
    return deny('WINDOW_EXPIRED', `Đã quá ${cs.windowHours} giờ kể từ tương tác gần nhất của khách nên không thể gửi tin tư vấn Zalo. Hệ thống không tự chuyển sang loại tin khác. Bản nháp được giữ lại.`);
  }
}

function pick(r: PolicyRule) {
  return { id: r.id, category: r.category, version: r.version };
}

function label(t: ChannelType) {
  return t === 'FACEBOOK' ? 'Facebook' : 'Zalo';
}
