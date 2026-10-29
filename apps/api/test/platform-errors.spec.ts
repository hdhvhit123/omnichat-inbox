import { INestApplication } from '@nestjs/common';
import { CredentialService } from '../src/channels/credential.service';
import { QueueService } from '../src/common/queue.service';
import { decrypt } from '../src/common/crypto';
import { OutboxProcessor } from '../src/outbox/outbox.processor';
import { createApp, FakePlatform, login, makeUser, makeWorkspace, pointPlatformsTo, prisma, resetDb } from './helpers';

describe('Lỗi nền tảng: token hết hạn, giới hạn tốc độ, timeout', () => {
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
    app.get(QueueService).delayed.length = 0;
  });

  async function setup(type: 'FACEBOOK' | 'ZALO') {
    const { ws, channels } = await makeWorkspace({ channels: [{ type }] });
    const ch = channels[0];
    const user = await makeUser(ws.id, 'OWNER');
    const customer = await prisma.customer.create({ data: { workspaceId: ws.id, displayName: 'K' } });
    const identity = await prisma.customerIdentity.create({ data: { workspaceId: ws.id, customerId: customer.id, channelId: ch.id, externalUserId: 'USER1' } });
    const conv = await prisma.conversation.create({ data: { workspaceId: ws.id, channelId: ch.id, customerId: customer.id, identityId: identity.id, lastInboundAt: new Date() } });
    const s = await login(app, user.email, ws.id);
    return { ws, ch, conv, s };
  }

  it('Facebook token hết hạn (190): tin thất bại, kênh chuyển trạng thái lỗi, không retry', async () => {
    fake.handler = async () => ({ status: 400, body: { error: { code: 190, message: 'Error validating access token' } } });
    const { ch, conv, s } = await setup('FACEBOOK');
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Hi', clientMsgId: 'err-00001' }).expect(201);
    const m = await prisma.message.findUniqueOrThrow({ where: { id: r.body.message.id } });
    expect(m.status).toBe('FAILED');
    expect(m.errorMessage).toMatch(/Cần cấp quyền lại/);
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: ch.id } });
    expect(channel.status).toBe('ERROR');
    expect(fake.sends()).toHaveLength(1);
    expect(app.get(QueueService).delayed).toHaveLength(0);
    // Kênh lỗi → lần gửi tiếp bị chặn trước khi gọi API
    const r2 = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Hi', clientMsgId: 'err-00002' }).expect(422);
    expect(r2.body.reasonCode).toBe('CHANNEL_NOT_CONNECTED');
  });

  it('Facebook rate limit: giữ chờ gửi, lên lịch thử lại có backoff, lần sau thành công', async () => {
    let n = 0;
    fake.handler = async () => (++n === 1 ? { status: 400, body: { error: { code: 613, message: 'Calls to this api have exceeded the rate limit.' } } } : { body: { recipient_id: 'USER1', message_id: 'mid.ok' } });
    const { conv, s } = await setup('FACEBOOK');
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Hi', clientMsgId: 'rl-00001' }).expect(201);
    let m = await prisma.message.findUniqueOrThrow({ where: { id: r.body.message.id } });
    expect(m.status).toBe('PENDING');
    const q = app.get(QueueService);
    expect(q.delayed).toHaveLength(1);
    expect(q.delayed[0].delayMs).toBeGreaterThanOrEqual(2000);
    await app.get(OutboxProcessor).process(q.delayed[0].data.outboundId);
    m = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(m.status).toBe('ACCEPTED');
    expect(m.externalId).toBe('mid.ok');
    expect(fake.sends()).toHaveLength(2);
  });

  it('timeout: đánh dấu chưa xác định, KHÔNG retry mù; echo sau đó đối soát thành đã gửi', async () => {
    fake.handler = async () => ({ delayMs: 1500, body: { recipient_id: 'USER1', message_id: 'mid.late' } });
    const { ch, conv, s } = await setup('FACEBOOK');
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Hi', clientMsgId: 'to-00001' }).expect(201);
    const m = await prisma.message.findUniqueOrThrow({ where: { id: r.body.message.id }, include: { outbound: true } });
    expect(m.status).toBe('UNKNOWN');
    expect(app.get(QueueService).delayed).toHaveLength(0);
    expect(fake.sends()).toHaveLength(1);
    // Echo từ Meta mang metadata → xác nhận tin đã gửi
    const { WebhookIngestService } = await import('../src/webhooks/webhook-ingest.service');
    const { parseFacebook } = await import('../src/webhooks/facebook.parser');
    await app.get(WebhookIngestService).ingest(parseFacebook({ object: 'page', entry: [{ id: ch.externalId, time: Date.now(), messaging: [{ sender: { id: ch.externalId }, recipient: { id: 'USER1' }, timestamp: Date.now(), message: { mid: 'mid.late', text: 'Hi', is_echo: true, metadata: `omni:${m.outbound!.id}` } }] }] }));
    const after = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.status).toBe('ACCEPTED');
    expect(after.externalId).toBe('mid.late');
  });

  it('Zalo access token hết hạn: làm mới một lần rồi gửi lại thành công', async () => {
    let sends = 0;
    fake.handler = async (req) => {
      if (req.path.includes('/v4/oa/access_token')) return { body: { access_token: 'new-access', refresh_token: 'refresh-2', expires_in: '90000' } };
      if (req.path.includes('/message/cs')) return ++sends === 1 ? { body: { error: -216, message: 'Access token is invalid' } } : { body: { error: 0, message: 'Success', data: { message_id: 'zmid.1', user_id: 'USER1' } } };
      return { body: {} };
    };
    const { ch, conv, s } = await setup('ZALO');
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'Xin chào', clientMsgId: 'zl-00001' }).expect(201);
    const m = await prisma.message.findUniqueOrThrow({ where: { id: r.body.message.id } });
    expect(m.status).toBe('ACCEPTED');
    expect(fake.calls.filter((c) => c.path.includes('access_token'))).toHaveLength(1);
    expect(fake.sends()[1].headers['access_token']).toBe('new-access');
    const cred = await prisma.channelCredential.findUniqueOrThrow({ where: { channelId: ch.id } });
    expect(decrypt(cred.refreshTokenEnc!)).toBe('refresh-2'); // refresh token mới được lưu
  });

  it('nhiều tiến trình cùng làm mới token Zalo chỉ gọi API refresh một lần', async () => {
    fake.handler = async (req) => (req.path.includes('/v4/oa/access_token') ? { delayMs: 150, body: { access_token: 'acc-2', refresh_token: 'ref-2', expires_in: '90000' } } : { body: {} });
    const { ch } = await setup('ZALO');
    const creds = app.get(CredentialService);
    const v = await creds.currentVersion(ch.id);
    const tokens = await Promise.all(Array.from({ length: 6 }, () => creds.refreshZalo(ch.id, v)));
    expect(new Set(tokens)).toEqual(new Set(['acc-2']));
    expect(fake.calls.filter((c) => c.path.includes('/v4/oa/access_token'))).toHaveLength(1);
  });

  it('refresh token Zalo không hợp lệ: kênh báo lỗi cần cấp quyền lại', async () => {
    fake.handler = async (req) => (req.path.includes('/v4/oa/access_token') ? { body: { error: -14014, error_description: 'Invalid refresh token' } } : { body: { error: -216, message: 'invalid' } });
    const { ch, conv, s } = await setup('ZALO');
    const r = await s.post(`/api/conversations/${conv.id}/messages`).send({ text: 'x', clientMsgId: 'zl-00002' }).expect(201);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: r.body.message.id } })).status).toBe('FAILED');
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: ch.id } });
    expect(channel.status).toBe('ERROR');
  });
});
