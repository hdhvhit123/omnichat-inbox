import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import { io } from 'socket.io-client';
import { createApp, login, makeUser, makeWorkspace, prisma, resetDb } from './helpers';

async function seedConversation(workspaceId: string, channelId: string, text = 'xin chào bí mật') {
  const customer = await prisma.customer.create({ data: { workspaceId, displayName: 'Khách A', searchText: 'khach a' } });
  const identity = await prisma.customerIdentity.create({ data: { workspaceId, customerId: customer.id, channelId, externalUserId: `u-${Math.random()}` } });
  const conv = await prisma.conversation.create({ data: { workspaceId, channelId, customerId: customer.id, identityId: identity.id, lastInboundAt: new Date(), lastMessageAt: new Date() } });
  await prisma.message.create({ data: { workspaceId, conversationId: conv.id, channelId, direction: 'INBOUND', senderType: 'CUSTOMER', text, status: 'RECEIVED', sentAt: new Date(), searchText: 'xin chao bi mat' } });
  const file = await prisma.fileObject.create({ data: { workspaceId, storageKey: `${workspaceId}/k-${Math.random()}`, filename: 'a.png', mime: 'image/png', size: 10, sha256: 'x' } });
  await prisma.message.create({ data: { workspaceId, conversationId: conv.id, channelId, direction: 'INBOUND', senderType: 'CUSTOMER', attachments: [{ fileId: file.id, type: 'image' }], status: 'RECEIVED', sentAt: new Date() } });
  return { conv, customer, file };
}

describe('Phân quyền & cách ly workspace', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
  });
  afterAll(() => app.close());
  beforeEach(resetDb);

  it('không truy cập chéo workspace: API, tìm kiếm, gửi tin, tệp, khách hàng', async () => {
    const A = await makeWorkspace({ channels: [{ type: 'FACEBOOK' }] });
    const B = await makeWorkspace({ channels: [{ type: 'FACEBOOK' }] });
    const userA = await makeUser(A.ws.id, 'OWNER');
    const b = await seedConversation(B.ws.id, B.channels[0].id);
    const s = await login(app, userA.email, A.ws.id);

    // Dùng header workspace B → bị từ chối
    await s.agent.get('/api/conversations').set('x-workspace-id', B.ws.id).expect(403);
    // Dùng workspace A nhưng id của B → không tồn tại
    await s.get(`/api/conversations/${b.conv.id}`).expect(404);
    await s.get(`/api/conversations/${b.conv.id}/timeline`).expect(404);
    await s.post(`/api/conversations/${b.conv.id}/messages`).send({ text: 'x', clientMsgId: 'abcdefgh1' }).expect(404);
    await s.post(`/api/conversations/${b.conv.id}/notes`).send({ body: 'x' }).expect(404);
    await s.get(`/api/files/${b.file.id}/url`).expect(404);
    await s.get(`/api/customers/${b.customer.id}`).expect(404);
    const search = await s.get('/api/conversations?q=bí mật').expect(200);
    expect(search.body.items).toHaveLength(0);
    const exp = await s.get('/api/export/conversations.csv').expect(200);
    expect(exp.text).not.toContain(b.conv.id);
  });

  it('nhân viên chỉ thấy hội thoại thuộc kênh được cấp hoặc được giao', async () => {
    const A = await makeWorkspace({ channels: [{ type: 'FACEBOOK' }, { type: 'ZALO' }] });
    const agent = await makeUser(A.ws.id, 'AGENT', [A.channels[0].id]);
    const own = await seedConversation(A.ws.id, A.channels[0].id);
    const other = await seedConversation(A.ws.id, A.channels[1].id);
    const s = await login(app, agent.email, A.ws.id);
    const list = await s.get('/api/conversations').expect(200);
    expect(list.body.items.map((c: any) => c.id)).toEqual([own.conv.id]);
    await s.get(`/api/conversations/${other.conv.id}`).expect(404);
    await s.get(`/api/files/${other.file.id}/url`).expect(404);
    // Được giao thì thấy
    await prisma.conversation.update({ where: { id: other.conv.id }, data: { assigneeId: agent.id } });
    await s.get(`/api/conversations/${other.conv.id}`).expect(200);
    // Nhân viên không đổi được cấu hình
    await s.post('/api/rules').send({}).expect(403);
    await s.post('/api/members').send({}).expect(403);
  });

  it('người xem chỉ đọc', async () => {
    const A = await makeWorkspace({ channels: [{ type: 'FACEBOOK' }] });
    const viewer = await makeUser(A.ws.id, 'VIEWER');
    const c = await seedConversation(A.ws.id, A.channels[0].id);
    const s = await login(app, viewer.email, A.ws.id);
    await s.get(`/api/conversations/${c.conv.id}`).expect(200);
    await s.post(`/api/conversations/${c.conv.id}/messages`).send({ text: 'x', clientMsgId: 'abcdefgh2' }).expect(403);
    await s.post(`/api/conversations/${c.conv.id}/notes`).send({ body: 'x' }).expect(403);
  });

  it('WebSocket: không vào được phòng của workspace khác và không nhận sự kiện của nó', async () => {
    const A = await makeWorkspace({ channels: [{ type: 'FACEBOOK' }] });
    const B = await makeWorkspace({ channels: [{ type: 'FACEBOOK' }] });
    const userA = await makeUser(A.ws.id, 'OWNER');
    const s = await login(app, userA.email, A.ws.id);
    const cookie = (await s.agent.get('/api/auth/me')).request.getHeader?.('cookie');
    const jar = (s.agent as any).jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false });
    const cookieHeader = jar.map((c: any) => `${c.name}=${c.value}`).join('; ') || cookie;
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const sock = io(`http://127.0.0.1:${port}`, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: cookieHeader } });
    await new Promise<void>((ok, fail) => { sock.on('connect', () => ok()); sock.on('connect_error', fail); });
    const denied = await sock.emitWithAck('join', { workspaceId: B.ws.id });
    expect(denied.ok).toBe(false);
    const ok = await sock.emitWithAck('join', { workspaceId: A.ws.id });
    expect(ok.ok).toBe(true);
    const bConv = await seedConversation(B.ws.id, B.channels[0].id);
    const viewDenied = await sock.emitWithAck('viewing', { conversationId: bConv.conv.id });
    expect(viewDenied.ok).toBe(false);
    sock.close();

    const anon = io(`http://127.0.0.1:${port}`, { path: '/socket.io', transports: ['websocket'] });
    const err = await new Promise((ok) => anon.on('auth.error', ok));
    expect(err).toBeTruthy();
    anon.close();
  });
});
