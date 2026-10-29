import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Channel, ChannelType, PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, createHmac } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { resetConfig } from '../src/config';
import { encrypt } from '../src/common/crypto';

export const prisma = new PrismaClient();
const PW_HASH = bcrypt.hashSync('Passw0rd!', 4);

export async function createApp() {
  resetConfig();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  const base = { effectiveFrom: new Date('2026-01-01'), verifiedAt: new Date(), version: 1, sourceUrl: 'https://example.test' };
  await prisma.policyRule.createMany({
    data: [
      { ...base, channelType: 'FACEBOOK', category: 'RESPONSE', windowHours: 24, allowedSenders: ['AGENT', 'BOT', 'RULE'], verificationStatus: 'VERIFIED' },
      { ...base, channelType: 'FACEBOOK', category: 'HUMAN_AGENT', windowHours: 168, allowedSenders: ['AGENT'], verificationStatus: 'VERIFIED' },
      { ...base, channelType: 'ZALO', category: 'CS', windowHours: 48, allowedSenders: ['AGENT', 'BOT', 'RULE'], verificationStatus: 'SECONDARY' },
    ],
  });
}

let seq = 0;
export async function makeWorkspace(opts: { isDemo?: boolean; channels?: { type: ChannelType; simulated?: boolean; botMode?: 'MANUAL' | 'ASSIST' | 'AUTO'; externalId?: string }[] } = {}) {
  seq++;
  const ws = await prisma.workspace.create({ data: { name: `WS ${seq}`, slug: `ws-${seq}-${Date.now()}`, isDemo: !!opts.isDemo } });
  const channels: Channel[] = [];
  for (const c of opts.channels ?? []) {
    const ch: Channel = await prisma.channel.create({
      data: { workspaceId: ws.id, type: c.type, externalId: c.externalId ?? `${c.type.toLowerCase()}_${seq}_${channels.length}`, name: `${c.type} ${seq}`, status: 'CONNECTED', isSimulated: !!c.simulated, botMode: c.botMode ?? 'MANUAL' },
    });
    if (!c.simulated) {
      await prisma.channelCredential.create({
        data: { channelId: ch.id, workspaceId: ws.id, accessTokenEnc: encrypt(`token-${ch.id}`), refreshTokenEnc: c.type === 'ZALO' ? encrypt('refresh-1') : null, accessTokenExpiresAt: c.type === 'ZALO' ? new Date(Date.now() + 3600_000) : null },
      });
    }
    channels.push(ch);
  }
  await prisma.aiSettings.create({ data: { workspaceId: ws.id } });
  return { ws, channels };
}

export async function makeUser(workspaceId: string, role: Role, channelIds?: string[]) {
  seq++;
  const user = await prisma.user.create({ data: { email: `u${seq}-${Date.now()}@test.local`, name: `User ${seq}`, passwordHash: PW_HASH } });
  await prisma.membership.create({ data: { workspaceId, userId: user.id, role, channelAccess: channelIds ? { create: channelIds.map((channelId) => ({ channelId })) } : undefined } });
  return user;
}

/** Đăng nhập, trả về agent supertest giữ cookie + header workspace. */
export async function login(app: INestApplication, email: string, workspaceId: string) {
  const agent = request.agent(app.getHttpServer());
  const r = await agent.post('/api/auth/login').send({ email, password: 'Passw0rd!' });
  if (r.status !== 201) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('x-workspace-id', workspaceId);
  return { agent, get: wrap('get'), post: wrap('post'), patch: wrap('patch'), del: wrap('delete') };
}

export function fbSign(body: string, secret = 'test-meta-secret') {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function zaloSign(body: string, secret = 'zalo-oa-secret') {
  const b = JSON.parse(body);
  return 'mac=' + createHash('sha256').update(`${b.app_id}${body}${b.timestamp}${secret}`).digest('hex');
}

export function fbInbound(pageId: string, psid: string, mid: string, text: string, ts = Date.now()) {
  return { object: 'page', entry: [{ id: pageId, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: ts, message: { mid, text } }] }] };
}

/** Máy chủ HTTP giả lập Graph API / Zalo Open API; ghi lại mọi request. */
export class FakePlatform {
  server!: http.Server;
  url = '';
  calls: { method: string; path: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
  handler: (req: { method: string; path: string; body: any }) => Promise<{ status?: number; body: any; delayMs?: number; headers?: Record<string, string> }> = async () => ({ body: {} });

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        let body: any = raw;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          /* form */
        }
        const call = { method: req.method!, path: req.url!, body, headers: req.headers };
        this.calls.push(call);
        const r = await this.handler(call);
        if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
        if (res.destroyed) return;
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  sends() {
    return this.calls.filter((c) => c.path.includes('/messages') || c.path.includes('/message/cs'));
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((ok) => this.server.close(ok));
  }
}

export function pointPlatformsTo(url: string) {
  process.env.META_GRAPH_BASE = url;
  process.env.ZALO_OPENAPI_BASE = url;
  process.env.ZALO_OAUTH_BASE = url;
  resetConfig();
}
