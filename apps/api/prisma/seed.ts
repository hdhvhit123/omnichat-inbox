/* eslint-disable no-console */
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { chunkText } from '../src/ai/knowledge.service';
import { normalizeVi, preview } from '../src/common/text';

const prisma = new PrismaClient();
const VERIFIED_AT = new Date('2026-10-29T00:00:00Z');

/** Quy tắc chính sách mặc định của hệ thống — nguồn và mức xác minh: docs/PLATFORM_SOURCES.md */
async function seedPolicies() {
  const rules = [
    {
      channelType: 'FACEBOOK' as const, category: 'RESPONSE', windowHours: 24, allowedSenders: ['AGENT', 'BOT', 'RULE'],
      sourceUrl: 'https://developers.facebook.com/docs/messenger-platform/send-messages', verificationStatus: 'VERIFIED',
      notes: 'Cửa sổ tiêu chuẩn 24 giờ từ tương tác của người dùng; messaging_type=RESPONSE.',
    },
    {
      channelType: 'FACEBOOK' as const, category: 'HUMAN_AGENT', windowHours: 168, allowedSenders: ['AGENT'],
      sourceUrl: 'https://developers.facebook.com/docs/messenger-platform/send-messages', verificationStatus: 'VERIFIED',
      notes: 'Tag HUMAN_AGENT: nhân viên trả lời thủ công trong 7 ngày. Cần quyền Human Agent được Meta duyệt; chỉ dùng khi workspace bật.',
    },
    {
      channelType: 'ZALO' as const, category: 'CS', windowHours: 48, allowedSenders: ['AGENT', 'BOT', 'RULE'],
      sourceUrl: 'https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van', verificationStatus: 'SECONDARY',
      notes: 'Tin tư vấn trong 48 giờ kể từ tương tác gần nhất — lấy từ nguồn phụ (SDK cộng đồng), trang tài liệu chính thức không truy cập được khi xây dựng. Chủ sở hữu cần xác minh và tạo phiên bản mới nếu khác.',
    },
  ];
  for (const r of rules) {
    const exists = await prisma.policyRule.findFirst({ where: { workspaceId: null, channelType: r.channelType, category: r.category, version: 1 } });
    if (!exists) await prisma.policyRule.create({ data: { ...r, version: 1, effectiveFrom: new Date('2026-01-01T00:00:00Z'), verifiedAt: VERIFIED_AT } });
  }
}

async function user(email: string, name: string, password: string) {
  return prisma.user.upsert({ where: { email }, create: { email, name, passwordHash: await bcrypt.hash(password, 12) }, update: {} });
}

const FAQ = `Q: Cửa hàng mở cửa mấy giờ?
A: Cửa hàng mở cửa từ 8:00 đến 21:00 tất cả các ngày trong tuần, kể cả Chủ nhật.

Q: Địa chỉ cửa hàng ở đâu?
A: Cửa hàng ở số 12 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh.

Q: Phí giao hàng bao nhiêu?
A: Giao hàng nội thành TP.HCM phí 25.000đ, miễn phí cho đơn từ 500.000đ. Ngoại tỉnh giao qua đối tác vận chuyển, phí tính theo cân nặng.

Q: Bảng giá áo thun basic?
A: Áo thun basic cotton giá 199.000đ/chiếc, combo 3 chiếc 549.000đ. Có size S, M, L, XL.

Q: Chính sách đổi trả thế nào?
A: Đổi size trong 7 ngày nếu sản phẩm còn tem mác và chưa qua sử dụng. Mọi yêu cầu hoàn tiền cần nhân viên xác nhận.

Q: Có thanh toán chuyển khoản không?
A: Có. Cửa hàng nhận tiền mặt khi nhận hàng (COD) và chuyển khoản ngân hàng.`;

async function seedDemo(owner: { id: string }, extra: { manager: string; agent: string; viewer: string }) {
  let ws = await prisma.workspace.findUnique({ where: { slug: 'demo' } });
  if (ws) {
    console.log('Workspace demo đã tồn tại — bỏ qua');
    return ws;
  }
  ws = await prisma.workspace.create({
    data: {
      name: 'Cửa hàng Demo (dữ liệu mô phỏng)', slug: 'demo', isDemo: true,
      businessHours: { mon: [['08:00', '21:00']], tue: [['08:00', '21:00']], wed: [['08:00', '21:00']], thu: [['08:00', '21:00']], fri: [['08:00', '21:00']], sat: [['08:00', '21:00']], sun: [['08:00', '21:00']] },
    },
  });
  const fb = await prisma.channel.create({ data: { workspaceId: ws.id, type: 'FACEBOOK', externalId: 'demo_page_1001', name: 'Fanpage Thời Trang Demo', status: 'CONNECTED', isSimulated: true, botMode: 'ASSIST', lastVerifiedAt: new Date() } });
  const zl = await prisma.channel.create({ data: { workspaceId: ws.id, type: 'ZALO', externalId: 'demo_oa_2002', name: 'Zalo OA Thời Trang Demo', status: 'CONNECTED', isSimulated: true, botMode: 'AUTO', lastVerifiedAt: new Date() } });

  await prisma.membership.create({ data: { workspaceId: ws.id, userId: owner.id, role: 'OWNER' } });
  await prisma.membership.create({ data: { workspaceId: ws.id, userId: extra.manager, role: 'MANAGER' } });
  await prisma.membership.create({ data: { workspaceId: ws.id, userId: extra.agent, role: 'AGENT', channelAccess: { create: [{ channelId: fb.id }, { channelId: zl.id }] } } });
  await prisma.membership.create({ data: { workspaceId: ws.id, userId: extra.viewer, role: 'VIEWER' } });

  const tags = await Promise.all(
    [['Khách mới', '#2563eb'], ['Hỏi giá', '#d97706'], ['Khiếu nại', '#dc2626'], ['VIP', '#7c3aed']].map(([name, color]) => prisma.tag.create({ data: { workspaceId: ws!.id, name, color } })),
  );

  await prisma.cannedResponse.createMany({
    data: [
      { workspaceId: ws.id, shortcut: 'chao', title: 'Lời chào', body: 'Dạ em chào anh/chị, em có thể hỗ trợ gì cho mình ạ?' },
      { workspaceId: ws.id, shortcut: 'diachi', title: 'Địa chỉ', body: 'Dạ cửa hàng ở số 12 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP.HCM, mở cửa 8:00–21:00 hằng ngày ạ.' },
      { workspaceId: ws.id, shortcut: 'camon', title: 'Cảm ơn', body: 'Cảm ơn anh/chị đã liên hệ. Chúc anh/chị một ngày tốt lành ạ!' },
    ],
  });

  await prisma.automationRule.createMany({
    data: [
      { workspaceId: ws.id, name: 'Chào khách mới', enabled: true, testMode: false, trigger: 'NEW_CONVERSATION', priority: 10, isGreeting: true, maxRunsPerConversation: 1, conditions: {}, actions: [{ type: 'SEND_TEXT', text: 'Dạ em chào anh/chị! Cảm ơn anh/chị đã nhắn tin cho Thời Trang Demo 👋' }, { type: 'ADD_TAG', tagName: 'Khách mới' }] },
      { workspaceId: ws.id, name: 'Trả lời ngoài giờ', enabled: true, testMode: false, trigger: 'OUTSIDE_HOURS', priority: 20, cooldownSeconds: 6 * 3600, conditions: {}, actions: [{ type: 'SEND_TEXT', text: 'Dạ hiện đã ngoài giờ làm việc (8:00–21:00). Nhân viên sẽ phản hồi anh/chị vào sáng mai ạ.' }] },
      { workspaceId: ws.id, name: 'Khách muốn gặp nhân viên', enabled: true, testMode: false, trigger: 'INBOUND_MESSAGE', priority: 5, conditions: { intents: ['human', 'complaint'] }, actions: [{ type: 'SEND_TEXT', text: 'Dạ em đã chuyển cho nhân viên, anh/chị chờ em một chút nhé.' }, { type: 'HANDOFF', reason: 'Khách yêu cầu người thật hoặc khiếu nại' }] },
      { workspaceId: ws.id, name: 'Thu thập thông tin khi khách muốn đặt hàng', enabled: true, testMode: false, trigger: 'INBOUND_MESSAGE', priority: 30, cooldownSeconds: 24 * 3600, conditions: { keywords: ['đặt hàng', 'mua', 'chốt đơn', 'order'] }, actions: [{ type: 'START_LEAD_CAPTURE' }] },
      { workspaceId: ws.id, name: 'Gắn nhãn hỏi giá (đang thử)', enabled: true, testMode: true, trigger: 'INBOUND_MESSAGE', priority: 50, conditions: { intents: ['price'] }, actions: [{ type: 'ADD_TAG', tagName: 'Hỏi giá' }] },
    ],
  });

  const doc = await prisma.knowledgeDocument.create({ data: { workspaceId: ws.id, groupId: 'demo-faq', version: 1, title: 'FAQ cửa hàng', sourceType: 'FAQ', status: 'READY', approved: true, rawText: FAQ, createdById: owner.id } });
  await prisma.knowledgeChunk.createMany({ data: chunkText(FAQ, 'FAQ').map((c, i) => ({ workspaceId: ws!.id, documentId: doc.id, ordinal: i, content: c, normalized: normalizeVi(`${doc.title} ${c}`) })) });
  await prisma.aiSettings.create({ data: { workspaceId: ws.id, provider: 'mock', model: 'mock-kb-1', dailyBudgetUsd: 1, monthlyBudgetUsd: 10 } });

  // Hội thoại mẫu
  const now = Date.now();
  const samples: { ch: typeof fb; user: string; name: string; msgs: [number, 'in' | 'agent' | 'bot', string][]; status?: 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED'; tag?: number; assign?: string }[] = [
    { ch: fb, user: 'psid_demo_001', name: 'Nguyễn Thu Hà', msgs: [[-35, 'in', 'Shop ơi áo thun basic còn size M không ạ?'], [-34, 'bot', 'Dạ em chào anh/chị! Cảm ơn anh/chị đã nhắn tin cho Thời Trang Demo 👋'], [-20, 'agent', 'Dạ size M vẫn còn ạ, chị lấy màu gì ạ?'], [-5, 'in', 'Màu trắng nha shop, giá bao nhiêu vậy?']], status: 'OPEN', tag: 1, assign: extra.agent },
    { ch: fb, user: 'psid_demo_002', name: 'Trần Minh Quân', msgs: [[-60 * 30, 'in', 'Cho mình hỏi chính sách đổi trả'], [-60 * 30 + 1, 'bot', 'Dạ em chào anh/chị! Cảm ơn anh/chị đã nhắn tin cho Thời Trang Demo 👋']], status: 'NEW' },
    { ch: zl, user: 'zalo_demo_101', name: 'Lê Hoàng Yến', msgs: [[-12, 'in', 'Cửa hàng ở đâu vậy ạ?'], [-11, 'bot', 'Dạ, Cửa hàng ở số 12 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh.']], status: 'PENDING' },
    { ch: zl, user: 'zalo_demo_102', name: 'Phạm Đức Anh', msgs: [[-60 * 72, 'in', 'Hàng giao chậm quá, tôi muốn khiếu nại'], [-60 * 71, 'agent', 'Dạ em xin lỗi anh, em kiểm tra đơn ngay ạ.']], status: 'OPEN', tag: 2, assign: extra.manager },
    { ch: fb, user: 'psid_demo_003', name: 'Võ Thanh Tâm', msgs: [[-60 * 5, 'in', 'Cảm ơn shop nhé'], [-60 * 5 + 2, 'agent', 'Cảm ơn chị đã ủng hộ ạ!']], status: 'RESOLVED' },
  ];
  for (const s of samples) {
    const customer = await prisma.customer.create({ data: { workspaceId: ws.id, displayName: s.name, source: `${s.ch.type === 'FACEBOOK' ? 'Facebook' : 'Zalo'}: ${s.ch.name}`, searchText: normalizeVi(s.name) } });
    const identity = await prisma.customerIdentity.create({ data: { workspaceId: ws.id, customerId: customer.id, channelId: s.ch.id, externalUserId: s.user, displayName: s.name } });
    const firstIn = new Date(now + s.msgs[0][0] * 60_000);
    const lastIn = new Date(now + Math.max(...s.msgs.filter((m) => m[1] === 'in').map((m) => m[0])) * 60_000);
    const last = s.msgs[s.msgs.length - 1];
    const firstAgent = s.msgs.find((m) => m[1] === 'agent');
    const conv = await prisma.conversation.create({
      data: {
        workspaceId: ws.id, channelId: s.ch.id, customerId: customer.id, identityId: identity.id, status: s.status ?? 'NEW',
        assigneeId: s.assign ?? null, firstInboundAt: firstIn, lastInboundAt: lastIn, lastMessageAt: new Date(now + last[0] * 60_000),
        lastMessagePreview: preview(last[2]), unreadCount: last[1] === 'in' ? 1 : 0, greetedAt: s.msgs.some((m) => m[1] === 'bot') ? firstIn : null,
        firstHumanReplyAt: firstAgent ? new Date(now + firstAgent[0] * 60_000) : null,
        resolvedAt: s.status === 'RESOLVED' ? new Date(now + last[0] * 60_000 + 60_000) : null,
        botPausedAt: firstAgent ? new Date(now + firstAgent[0] * 60_000) : null, botPausedById: firstAgent ? s.assign ?? extra.agent : null, botPausedReason: firstAgent ? 'Nhân viên đã trả lời' : null,
      },
    });
    if (s.tag !== undefined) await prisma.conversationTag.create({ data: { conversationId: conv.id, tagId: tags[s.tag].id } });
    let i = 0;
    for (const [min, who, text] of s.msgs) {
      i++;
      const at = new Date(now + min * 60_000);
      await prisma.message.create({
        data: {
          workspaceId: ws.id, conversationId: conv.id, channelId: s.ch.id, direction: who === 'in' ? 'INBOUND' : 'OUTBOUND',
          senderType: who === 'in' ? 'CUSTOMER' : who === 'agent' ? 'AGENT' : 'BOT', authorId: who === 'agent' ? s.assign ?? extra.agent : null,
          text, externalId: `seed_${s.user}_${i}`, status: who === 'in' ? 'RECEIVED' : 'READ', sentAt: at, deliveredAt: who === 'in' ? null : at, readAt: who === 'in' ? null : at,
          searchText: normalizeVi(text),
        },
      });
    }
  }
  await prisma.internalNote.create({ data: { workspaceId: ws.id, conversationId: (await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws.id, status: 'OPEN', channelId: fb.id } })).id, authorId: extra.agent, body: 'Khách quen, từng mua 2 lần. Ưu tiên giao nhanh.' } });
  return ws;
}

async function main() {
  await seedPolicies();
  const pw = process.env.SEED_DEMO_PASSWORD ?? 'Demo@12345';
  const owner = await user(process.env.SEED_OWNER_EMAIL ?? 'owner@demo.local', 'Chủ cửa hàng', pw);
  const manager = await user('manager@demo.local', 'Quản lý Lan', pw);
  const agent = await user('agent@demo.local', 'Nhân viên Minh', pw);
  const viewer = await user('viewer@demo.local', 'Người xem Hùng', pw);

  if (process.env.SEED_DEMO !== 'false') await seedDemo(owner, { manager: manager.id, agent: agent.id, viewer: viewer.id });

  // Workspace thật (trống) cho chủ sở hữu — tách biệt hoàn toàn khỏi dữ liệu demo
  const prod = await prisma.workspace.findUnique({ where: { slug: 'main' } });
  if (!prod) {
    const w = await prisma.workspace.create({ data: { name: 'Doanh nghiệp của tôi', slug: 'main', isDemo: false } });
    await prisma.membership.create({ data: { workspaceId: w.id, userId: owner.id, role: 'OWNER' } });
    await prisma.aiSettings.create({ data: { workspaceId: w.id } });
  }
  console.log(`Seed xong. Đăng nhập: owner@demo.local / manager@demo.local / agent@demo.local / viewer@demo.local — mật khẩu: ${process.env.SEED_DEMO_PASSWORD ? '(theo SEED_DEMO_PASSWORD)' : pw}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

export type _Unused = Prisma.JsonValue;
