import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MockProvider } from '../src/ai/providers';
import { SimulatedAdapter } from '../src/channels/adapters/simulated.adapter';
import { chunkText } from '../src/ai/knowledge.service';
import { normalizeVi } from '../src/common/text';
import { createApp, FakePlatform, fbInbound, fbSign, login, makeUser, makeWorkspace, pointPlatformsTo, prisma, resetDb } from './helpers';

async function addFaq(workspaceId: string) {
  const text = 'Q: Phí giao hàng bao nhiêu?\nA: Phí giao hàng nội thành 25.000đ.';
  const doc = await prisma.knowledgeDocument.create({ data: { workspaceId, groupId: `g-${workspaceId}`, title: 'FAQ', sourceType: 'FAQ', status: 'READY', approved: true, rawText: text } });
  await prisma.knowledgeChunk.createMany({ data: chunkText(text, 'FAQ').map((c, i) => ({ workspaceId, documentId: doc.id, ordinal: i, content: c, normalized: normalizeVi(`FAQ ${c}`) })) });
}

describe('AI: tiếp quản, căn cứ, chế độ demo', () => {
  let app: INestApplication;
  let fake: FakePlatform;
  beforeAll(async () => {
    fake = await new FakePlatform().start();
    pointPlatformsTo(fake.url);
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
    await fake.stop();
  });
  beforeEach(async () => {
    await resetDb();
    fake.calls = [];
    fake.handler = async () => ({ body: { recipient_id: 'U1', message_id: `mid.${Math.random()}` } });
    MockProvider.hook = null;
  });

  const post = (body: string) => request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body);

  it('AI tự động trả lời có căn cứ từ tài liệu đã duyệt', async () => {
    const { ws } = await makeWorkspace({ channels: [{ type: 'FACEBOOK', externalId: 'P-AI', botMode: 'AUTO' }] });
    await addFaq(ws.id);
    await post(JSON.stringify(fbInbound('P-AI', 'U1', 'm.ai.1', 'Phí giao hàng bao nhiêu vậy?'))).expect(200);
    const task = await prisma.aiTask.findFirstOrThrow();
    expect(task.status).toBe('SENT');
    expect((task.sources as any[])[0].title).toBe('FAQ');
    expect(fake.sends()).toHaveLength(1);
    expect(fake.sends()[0].body.message.text).toContain('25.000đ');
  });

  it('không có tài liệu phù hợp → chuyển nhân viên, không bịa câu trả lời', async () => {
    const { ws } = await makeWorkspace({ channels: [{ type: 'FACEBOOK', externalId: 'P-AI2', botMode: 'AUTO' }] });
    await addFaq(ws.id);
    await post(JSON.stringify(fbInbound('P-AI2', 'U1', 'm.ai.2', 'Còn hàng size XXL màu tím không?'))).expect(200);
    const task = await prisma.aiTask.findFirstOrThrow();
    expect(task.status).toBe('HANDOFF');
    const conv = await prisma.conversation.findFirstOrThrow();
    expect(conv.handoffAt).not.toBeNull();
    // Chỉ gửi câu báo chuyển nhân viên
    expect(fake.sends()).toHaveLength(1);
    expect(fake.sends()[0].body.message.text).toMatch(/chuyển hội thoại cho nhân viên/);
  });

  it('AI bịa con số không có trong tài liệu → không tự gửi, giữ nháp cho nhân viên', async () => {
    const { ws } = await makeWorkspace({ channels: [{ type: 'FACEBOOK', externalId: 'P-AI3', botMode: 'AUTO' }] });
    await addFaq(ws.id);
    MockProvider.hook = async (req) => ({ decision: { action: 'reply', reply: 'Phí giao hàng 15.000đ, giảm 50% hôm nay', used_source_ids: [req.sources[0].id], reason: '' }, inputTokens: 10, outputTokens: 10 });
    await post(JSON.stringify(fbInbound('P-AI3', 'U1', 'm.ai.3', 'Phí giao hàng bao nhiêu?'))).expect(200);
    const task = await prisma.aiTask.findFirstOrThrow();
    expect(task.status).toBe('DRAFTED');
    expect(task.reason).toMatch(/không có trong tài liệu/);
    expect(fake.sends()).toHaveLength(0);
  });

  it('nhân viên tiếp quản khi AI đang chạy thì bot không gửi', async () => {
    const { ws, channels } = await makeWorkspace({ channels: [{ type: 'FACEBOOK', externalId: 'P-TK', botMode: 'AUTO' }] });
    await addFaq(ws.id);
    const agent = await makeUser(ws.id, 'AGENT', [channels[0].id]);
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((ok) => (started = ok));
    MockProvider.hook = async () => {
      started();
      await new Promise<void>((ok) => (release = ok));
    };
    // Webhook chạy inline nên chờ AI; không await ở đây
    const pending = post(JSON.stringify(fbInbound('P-TK', 'U1', 'm.tk.1', 'Phí giao hàng bao nhiêu?'))).then((r) => r);
    await startedP;
    const conv = await prisma.conversation.findFirstOrThrow();
    const s = await login(app, agent.email, ws.id);
    await s.post(`/api/conversations/${conv.id}/takeover`).expect(201);
    release();
    await pending;
    const task = await prisma.aiTask.findFirstOrThrow();
    expect(task.status).toBe('CANCELLED');
    expect(await prisma.message.count({ where: { senderType: 'BOT' } })).toBe(0);
    expect(fake.sends()).toHaveLength(0);
  });

  it('tin bot đã xếp hàng bị huỷ nếu nhân viên tiếp quản trước khi gửi', async () => {
    const { ws, channels } = await makeWorkspace({ channels: [{ type: 'FACEBOOK', externalId: 'P-Q', botMode: 'MANUAL' }] });
    const agent = await makeUser(ws.id, 'AGENT', [channels[0].id]);
    await post(JSON.stringify(fbInbound('P-Q', 'U1', 'm.q.1', 'hi'))).expect(200);
    const conv = await prisma.conversation.findFirstOrThrow();
    // Tạo tin bot ở trạng thái QUEUED mà chưa xử lý
    const m = await prisma.message.create({ data: { workspaceId: ws.id, conversationId: conv.id, channelId: conv.channelId, direction: 'OUTBOUND', senderType: 'BOT', text: 'bot', status: 'PENDING', sentAt: new Date() } });
    const ob = await prisma.outboundMessage.create({ data: { workspaceId: ws.id, conversationId: conv.id, channelId: conv.channelId, messageId: m.id, requestedBy: 'BOT', sendParams: { messagingType: 'RESPONSE' } } });
    const s = await login(app, agent.email, ws.id);
    await s.post(`/api/conversations/${conv.id}/takeover`).expect(201);
    const { OutboxProcessor } = await import('../src/outbox/outbox.processor');
    await app.get(OutboxProcessor).process(ob.id);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: ob.id } })).status).toBe('CANCELLED');
    expect(fake.sends()).toHaveLength(0);
  });

  it('chế độ demo không gọi API gửi thật', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const { ws, channels } = await makeWorkspace({ isDemo: true, channels: [{ type: 'FACEBOOK', simulated: true, botMode: 'AUTO' }, { type: 'ZALO', simulated: true }] });
    await addFaq(ws.id);
    const owner = await makeUser(ws.id, 'OWNER');
    const s = await login(app, owner.email, ws.id);
    const sim = app.get(SimulatedAdapter);
    const before = sim.sentLog.length;
    await s.post('/api/demo/inbound').send({ channelId: channels[0].id, text: 'Phí giao hàng bao nhiêu?', customerName: 'Khách Demo' }).expect(201);
    const conv = await prisma.conversation.findFirstOrThrow({ include: { customer: true } });
    expect(conv.customer.displayName).toBe('Khách Demo');
    await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Nhân viên trả lời', clientMsgId: 'demo-msg-1' }).expect(201);
    expect(sim.sentLog.length - before).toBe(2); // AI + nhân viên, đều qua adapter mô phỏng
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
    // Tiêm lỗi gửi mô phỏng
    await s.post('/api/demo/fail-next-send').send({ channelId: channels[0].id, failure: 'timeout' }).expect(201);
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Tin sẽ timeout', clientMsgId: 'demo-msg-2' }).expect(201);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: r.body.message.id } })).status).toBe('UNKNOWN');
    fetchSpy.mockRestore();
  });

  it('công cụ mô phỏng bị chặn ở workspace thật; kênh mô phỏng không gửi được trong workspace thật', async () => {
    const { ws, channels } = await makeWorkspace({ isDemo: false, channels: [{ type: 'FACEBOOK', simulated: true }] });
    const owner = await makeUser(ws.id, 'OWNER');
    const s = await login(app, owner.email, ws.id);
    await s.post('/api/demo/inbound').send({ channelId: channels[0].id, text: 'x' }).expect(403);
    const customer = await prisma.customer.create({ data: { workspaceId: ws.id, displayName: 'K' } });
    const identity = await prisma.customerIdentity.create({ data: { workspaceId: ws.id, customerId: customer.id, channelId: channels[0].id, externalUserId: 'u' } });
    const conv = await prisma.conversation.create({ data: { workspaceId: ws.id, channelId: channels[0].id, customerId: customer.id, identityId: identity.id, lastInboundAt: new Date() } });
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'x', clientMsgId: 'iso-00001' }).expect(422);
    expect(r.body.reasonCode).toBe('DEMO_ISOLATION');
  });
});
