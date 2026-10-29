import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, FakePlatform, fbInbound, fbSign, login, makeUser, makeWorkspace, pointPlatformsTo, prisma, resetDb } from './helpers';

describe('Kiểm tra điều kiện gửi & ghi chú nội bộ', () => {
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
    fake.handler = async () => ({ body: { recipient_id: 'U1', message_id: `mid.${Math.random()}`, error: 0, data: { message_id: `z.${Math.random()}` } } });
  });

  async function setup(type: 'FACEBOOK' | 'ZALO', hoursAgo: number) {
    const { ws, channels } = await makeWorkspace({ channels: [{ type, externalId: `${type}-X` }] });
    const user = await makeUser(ws.id, 'AGENT', [channels[0].id]);
    const at = Date.now() - hoursAgo * 3600_000;
    if (type === 'FACEBOOK') {
      const body = JSON.stringify(fbInbound(`${type}-X`, 'U1', `m.${Math.random()}`, 'hi', at));
      await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body).expect(200);
    } else {
      const customer = await prisma.customer.create({ data: { workspaceId: ws.id, displayName: 'Z' } });
      const identity = await prisma.customerIdentity.create({ data: { workspaceId: ws.id, customerId: customer.id, channelId: channels[0].id, externalUserId: 'ZU1' } });
      await prisma.conversation.create({ data: { workspaceId: ws.id, channelId: channels[0].id, customerId: customer.id, identityId: identity.id, lastInboundAt: new Date(at) } });
    }
    const conv = await prisma.conversation.findFirstOrThrow({ where: { workspaceId: ws.id } });
    const s = await login(app, user.email, ws.id);
    return { ws, conv, s };
  }

  it('Facebook trong 24 giờ: gửi với messaging_type RESPONSE', async () => {
    const { conv, s } = await setup('FACEBOOK', 2);
    await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Dạ shop đây', clientMsgId: 'client-0001' }).expect(201);
    expect(fake.sends()).toHaveLength(1);
    expect(fake.sends()[0].body).toMatchObject({ messaging_type: 'RESPONSE', recipient: { id: 'U1' }, message: { text: 'Dạ shop đây' } });
    expect((await prisma.message.findFirstOrThrow({ where: { senderType: 'AGENT' } })).status).toBe('ACCEPTED');
  });

  it('hết cửa sổ gửi tin Facebook thì bị chặn, giải thích tiếng Việt, không gọi API', async () => {
    const { conv, s } = await setup('FACEBOOK', 30);
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Chào chị', clientMsgId: 'client-0002' }).expect(422);
    expect(r.body.code).toBe('SEND_BLOCKED');
    expect(r.body.reasonCode).toBe('WINDOW_EXPIRED');
    expect(r.body.message).toMatch(/24 giờ/);
    expect(fake.sends()).toHaveLength(0);
    expect(await prisma.outboundMessage.count()).toBe(0);
  });

  it('tag HUMAN_AGENT chỉ dùng khi workspace bật và chỉ cho nhân viên', async () => {
    const { ws, conv, s } = await setup('FACEBOOK', 30);
    await prisma.workspace.update({ where: { id: ws.id }, data: { fbHumanAgentTagEnabled: true } });
    await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Em hỗ trợ ạ', clientMsgId: 'client-0003' }).expect(201);
    expect(fake.sends()[0].body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
    // Bot không được dùng tag này
    const { OutboxService } = await import('../src/outbox/outbox.service');
    const r = await app.get(OutboxService).queueSend({ workspaceId: ws.id, conversationId: conv.id, requestedBy: 'BOT', text: 'bot', clientMsgId: 'bot-1' });
    expect(r.ok).toBe(false);
  });

  it('Zalo quá 48 giờ bị chặn; trong 48 giờ gửi tin tư vấn', async () => {
    const late = await setup('ZALO', 50);
    const r = await late.s.post(`/api/conversations/${late.conv.id}/messages`).send({ text: 'x', clientMsgId: 'client-0004' }).expect(422);
    expect(r.body.message).toMatch(/48 giờ/);
    await resetDb();
    const ok = await setup('ZALO', 1);
    await ok.s.post(`/api/conversations/${ok.conv.id}/messages`).send({ text: 'Dạ', clientMsgId: 'client-0005' }).expect(201);
    expect(fake.sends()[0].path).toContain('/v3.0/oa/message/cs');
    expect(fake.sends()[0].body).toEqual({ recipient: { user_id: 'ZU1' }, message: { text: 'Dạ' } });
  });

  it('bấm gửi hai lần cùng clientMsgId chỉ tạo một tin', async () => {
    const { conv, s } = await setup('FACEBOOK', 1);
    await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'A', clientMsgId: 'client-dup1' }).expect(201);
    const r2 = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'A', clientMsgId: 'client-dup1' }).expect(201);
    expect(r2.body.duplicate).toBe(true);
    expect(fake.sends()).toHaveLength(1);
  });

  it('ghi chú nội bộ không thể gửi ra kênh', async () => {
    const { conv, s } = await setup('FACEBOOK', 1);
    await s.post(`/api/conversations/${conv.id}/notes`).send({ body: 'Khách khó tính, cẩn thận' }).expect(201);
    expect(await prisma.internalNote.count()).toBe(1);
    expect(await prisma.outboundMessage.count()).toBe(0);
    expect(await prisma.message.count({ where: { direction: 'OUTBOUND' } })).toBe(0);
    expect(fake.sends()).toHaveLength(0);
    // Ghi chú xuất hiện trong dòng thời gian dưới dạng "note", không phải tin nhắn
    const t = await s.get(`/api/conversations/${conv.id}/timeline`).expect(200);
    expect(t.body.items.filter((i: any) => i.kind === 'note')).toHaveLength(1);
    // Không có tham số nào biến API gửi tin thành ghi chú hoặc ngược lại
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ body: 'note?', internal: true, clientMsgId: 'client-0006' });
    expect(r.status).toBe(400);
    expect(fake.sends()).toHaveLength(0);
  });
});
