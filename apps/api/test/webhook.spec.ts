import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, FakePlatform, fbInbound, fbSign, makeWorkspace, pointPlatformsTo, prisma, resetDb, zaloSign } from './helpers';

describe('Webhook: chữ ký, chống trùng, echo', () => {
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
    fake.handler = async () => ({ body: { recipient_id: 'x', message_id: `mid.api.${Math.random()}` } });
  });

  async function greetingSetup() {
    const { ws, channels } = await makeWorkspace({ channels: [{ type: 'FACEBOOK', externalId: 'PAGE1' }] });
    await prisma.automationRule.create({
      data: { workspaceId: ws.id, name: 'Chào', enabled: true, testMode: false, trigger: 'NEW_CONVERSATION', isGreeting: true, actions: [{ type: 'SEND_TEXT', text: 'Xin chào!' }] },
    });
    return { ws, ch: channels[0] };
  }

  it('xác minh URL webhook Facebook bằng verify token', async () => {
    await request(app.getHttpServer()).get('/api/webhooks/facebook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123').expect(200, '123');
    await request(app.getHttpServer()).get('/api/webhooks/facebook?hub.mode=subscribe&hub.verify_token=sai&hub.challenge=123').expect(403);
  });

  it('từ chối webhook Facebook sai chữ ký và không lưu gì', async () => {
    await greetingSetup();
    const body = JSON.stringify(fbInbound('PAGE1', 'U1', 'm1', 'hi'));
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body, 'secret-sai')).send(body).expect(401);
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').send(body).expect(401);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });

  it('từ chối webhook Zalo sai chữ ký', async () => {
    const body = JSON.stringify({ app_id: 'zalo-app', event_name: 'user_send_text', timestamp: '1700000000000', sender: { id: 'u' }, recipient: { id: 'oa' }, message: { msg_id: 'z1', text: 'hi' } });
    await request(app.getHttpServer()).post('/api/webhooks/zalo').set('Content-Type', 'application/json').set('X-ZEvent-Signature', zaloSign(body, 'sai')).send(body).expect(401);
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it('chấp nhận webhook Zalo đúng chữ ký', async () => {
    await makeWorkspace({ channels: [{ type: 'ZALO', externalId: 'OA1' }] });
    const body = JSON.stringify({ app_id: 'zalo-app', event_name: 'user_send_text', timestamp: String(Date.now()), sender: { id: 'zu1' }, recipient: { id: 'OA1' }, message: { msg_id: 'z1', text: 'Xin chào' } });
    await request(app.getHttpServer()).post('/api/webhooks/zalo').set('Content-Type', 'application/json').set('X-ZEvent-Signature', zaloSign(body)).send(body).expect(200);
    expect(await prisma.message.count({ where: { direction: 'INBOUND' } })).toBe(1);
  });

  it('webhook trùng không tạo hai tin hay hai câu trả lời', async () => {
    await greetingSetup();
    const body = JSON.stringify(fbInbound('PAGE1', 'U1', 'm.dup.1', 'Shop ơi'));
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body).expect(200);
    }
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.message.count({ where: { direction: 'INBOUND' } })).toBe(1);
    expect(await prisma.message.count({ where: { senderType: 'BOT' } })).toBe(1);
    expect(fake.sends()).toHaveLength(1);
    expect(fake.sends()[0].body.messaging_type).toBe('RESPONSE');
  });

  it('xử lý lại cùng một sự kiện (job chạy lại) không gửi lại câu trả lời', async () => {
    await greetingSetup();
    const body = JSON.stringify(fbInbound('PAGE1', 'U1', 'm.re.1', 'Shop ơi'));
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body).expect(200);
    const ev = await prisma.webhookEvent.findFirstOrThrow();
    // Giả lập worker chết sau khi xử lý: đặt lại trạng thái và chạy lại
    await prisma.webhookEvent.update({ where: { id: ev.id }, data: { status: 'RECEIVED' } });
    const { WebhookProcessorService } = await import('../src/webhooks/webhook-processor.service');
    await app.get(WebhookProcessorService).process(ev.id);
    expect(await prisma.message.count({ where: { senderType: 'BOT' } })).toBe(1);
    expect(fake.sends()).toHaveLength(1);
  });

  it('tin echo không kích hoạt bot; echo có metadata đối soát với tin đã gửi', async () => {
    const { ch } = await greetingSetup();
    const ts = Date.now();
    // Khách nhắn → bot chào (1 lần gửi)
    let body = JSON.stringify(fbInbound('PAGE1', 'U1', 'm.in.1', 'hello', ts));
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body).expect(200);
    const botMsg = await prisma.message.findFirstOrThrow({ where: { senderType: 'BOT' }, include: { outbound: true } });

    // Echo của chính tin bot (metadata omni:<outboundId>)
    const echo = (mid: string, text: string, metadata?: string) =>
      JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', time: ts, messaging: [{ sender: { id: 'PAGE1' }, recipient: { id: 'U1' }, timestamp: ts + 10, message: { mid, text, is_echo: true, app_id: 1, metadata } }] }] });
    body = echo('m.echo.bot', 'Xin chào!', `omni:${botMsg.outbound!.id}`);
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body).expect(200);

    // Echo của tin nhân viên gửi từ Meta Business Suite
    body = echo('m.echo.ext', 'Chị cần gì ạ?');
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body).expect(200);

    expect(fake.sends()).toHaveLength(1); // không có trả lời nào thêm
    expect(await prisma.message.count({ where: { senderType: 'BOT' } })).toBe(1);
    const ext = await prisma.message.findFirstOrThrow({ where: { externalId: 'm.echo.ext' } });
    expect(ext.sentOutsideSystem).toBe(true);
    expect(ext.senderType).toBe('AGENT');
    const conv = await prisma.conversation.findFirstOrThrow({ where: { channelId: ch.id } });
    expect(conv.botPausedAt).not.toBeNull(); // người thật đã trả lời → bot dừng
  });

  it('xác nhận đã đọc đến trước phản hồi/echo vẫn cập nhật đúng (sai thứ tự)', async () => {
    await greetingSetup();
    const ts = Date.now();
    const body = JSON.stringify(fbInbound('PAGE1', 'U1', 'm.in.2', 'hello', ts));
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(body)).send(body).expect(200);
    const read = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE1', time: ts, messaging: [{ sender: { id: 'U1' }, recipient: { id: 'PAGE1' }, timestamp: Date.now() + 5000, read: { watermark: Date.now() + 5000 } }] }] });
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(read)).send(read).expect(200);
    const bot = await prisma.message.findFirstOrThrow({ where: { senderType: 'BOT' } });
    expect(bot.status).toBe('READ');
    // Tin đến muộn hơn (timestamp cũ) không đổi lastInboundAt và không kích hoạt bot
    const old = JSON.stringify(fbInbound('PAGE1', 'U1', 'm.in.old', 'tin cũ', ts - 60 * 60_000));
    await request(app.getHttpServer()).post('/api/webhooks/facebook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fbSign(old)).send(old).expect(200);
    const conv = await prisma.conversation.findFirstOrThrow();
    expect(conv.lastInboundAt!.getTime()).toBe(ts);
    expect(fake.sends()).toHaveLength(1);
  });
});
