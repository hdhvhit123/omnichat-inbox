import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { config } from '../config';
import { AccessService } from '../auth/access.service';
import { ADMIN_ROLES, Public, Roles, Ws, WorkspaceCtx } from '../auth/context';
import { decrypt, encrypt, randomToken, sha256Hex } from '../common/crypto';
import { AppError, notFound } from '../common/errors';
import { platformFetch, redactUrl } from '../common/http';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../admin/audit.service';
import { AdapterRegistry } from './adapters/adapter.registry';
import { CredentialError, CredentialService } from './credential.service';

const FB_SCOPES = ['pages_show_list', 'pages_manage_metadata', 'pages_messaging', 'pages_read_engagement'];

const ManualDto = z.object({
  type: z.enum(['FACEBOOK', 'ZALO']),
  externalId: z.string().min(3).max(64),
  name: z.string().max(200).optional(),
  accessToken: z.string().min(10),
  refreshToken: z.string().optional(),
  accessExpiresInSec: z.number().int().positive().optional(),
});

@Controller()
export class ChannelsController {
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private adapters: AdapterRegistry,
    private credentials: CredentialService,
    private audit: AuditService,
  ) {}

  @Get('channels')
  async list(@Ws() ws: WorkspaceCtx) {
    const rows = await this.prisma.channel.findMany({
      where: this.access.channelWhere(ws),
      include: { credential: { select: { accessTokenExpiresAt: true, refreshTokenExpiresAt: true, scopes: true, lastRefreshedAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return { items: rows };
  }

  @Roles(...ADMIN_ROLES)
  @Patch('channels/:id')
  async update(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: { botMode?: 'MANUAL' | 'ASSIST' | 'AUTO'; name?: string }) {
    const ch = await this.prisma.channel.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!ch) throw notFound('Kênh');
    if (body.botMode && !['MANUAL', 'ASSIST', 'AUTO'].includes(body.botMode)) throw new AppError('VALIDATION', 'Chế độ bot không hợp lệ');
    const updated = await this.prisma.channel.update({ where: { id }, data: { botMode: body.botMode, name: body.name?.slice(0, 200) } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'channel.updated', targetType: 'channel', targetId: id, metadata: body });
    return { channel: updated };
  }

  /** Kiểm tra kết nối bằng API thật (hoặc mô phỏng với kênh demo). */
  @Roles(...ADMIN_ROLES)
  @Post('channels/:id/test')
  async test(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const ch = await this.prisma.channel.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!ch) throw notFound('Kênh');
    return { result: await this.verify(ch.id) };
  }

  private async verify(channelId: string) {
    const ch = await this.prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    const now = new Date();
    try {
      const token = await this.credentials.accessToken(ch);
      const r = await this.adapters.for(ch).verify(ch, token);
      if (r.ok) {
        if (r.externalId !== ch.externalId) {
          await this.prisma.channel.update({ where: { id: ch.id }, data: { status: 'ERROR', lastErrorCode: 'ID_MISMATCH', lastError: `Token thuộc tài khoản ${r.externalId}, không khớp ${ch.externalId}`, lastErrorAt: now } });
          return { ok: false, message: 'Token không thuộc tài khoản này' };
        }
        await this.prisma.channel.update({ where: { id: ch.id }, data: { status: 'CONNECTED', name: r.name || ch.name, avatarUrl: r.avatarUrl ?? ch.avatarUrl, lastVerifiedAt: now, lastApiSuccessAt: now, lastError: null, lastErrorCode: null } });
        return { ok: true, message: r.detail ?? 'Kết nối hoạt động' };
      }
      await this.prisma.channel.update({ where: { id: ch.id }, data: { status: 'ERROR', lastVerifiedAt: now, lastErrorCode: r.code, lastError: r.message, lastErrorAt: now } });
      return { ok: false, message: r.message, code: r.code };
    } catch (e) {
      const msg = e instanceof CredentialError ? e.message : 'Lỗi khi kiểm tra kết nối';
      await this.prisma.channel.update({ where: { id: ch.id }, data: { status: 'ERROR', lastVerifiedAt: now, lastErrorCode: e instanceof CredentialError ? e.code : 'VERIFY_ERROR', lastError: msg, lastErrorAt: now } });
      return { ok: false, message: msg };
    }
  }

  @Roles('OWNER')
  @Post('channels/:id/disconnect')
  async disconnect(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const ch = await this.prisma.channel.findFirst({ where: { id, workspaceId: ws.workspaceId }, include: { credential: true } });
    if (!ch) throw notFound('Kênh');
    if (ch.type === 'FACEBOOK' && ch.credential && !ch.isSimulated) {
      await this.adapters.facebook.unsubscribePage(ch.externalId, decrypt(ch.credential.accessTokenEnc)).catch(() => undefined);
    }
    await this.prisma.channelCredential.deleteMany({ where: { channelId: id } });
    await this.prisma.channel.update({ where: { id }, data: { status: 'DISCONNECTED' } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'channel.disconnected', targetType: 'channel', targetId: id });
    return { ok: true };
  }

  /** Nhập token thủ công (ví dụ token Page tạo trong Meta App Dashboard). Chỉ "Đã kết nối" sau khi API xác minh. */
  @Roles('OWNER')
  @Post('channels/manual')
  async manual(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    if (ws.isDemo) throw new AppError('DEMO', 'Workspace demo chỉ dùng kênh mô phỏng');
    const dto = parse(ManualDto, body);
    const channel = await this.upsertChannel(ws.workspaceId, dto.type, dto.externalId, dto.name ?? dto.externalId);
    await this.credentials.store(channel.id, ws.workspaceId, { accessToken: dto.accessToken, refreshToken: dto.refreshToken, accessExpiresInSec: dto.accessExpiresInSec });
    await this.prisma.channel.update({ where: { id: channel.id }, data: { status: 'PENDING' } });
    if (dto.type === 'FACEBOOK') await this.adapters.facebook.subscribePage(dto.externalId, dto.accessToken).catch(() => undefined);
    const result = await this.verify(channel.id);
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'channel.manual_token', targetType: 'channel', targetId: channel.id, metadata: { type: dto.type, verified: result.ok } });
    return { channel: await this.prisma.channel.findUnique({ where: { id: channel.id } }), result };
  }

  private async upsertChannel(workspaceId: string, type: 'FACEBOOK' | 'ZALO', externalId: string, name: string) {
    const existing = await this.prisma.channel.findUnique({ where: { type_externalId: { type, externalId } } });
    if (existing && existing.workspaceId !== workspaceId) throw new AppError('CHANNEL_TAKEN', 'Tài khoản này đã được kết nối với một workspace khác', 409);
    if (existing) return existing;
    return this.prisma.channel.create({ data: { workspaceId, type, externalId, name, status: 'PENDING' } });
  }

  private async newState(ws: WorkspaceCtx, provider: 'FACEBOOK' | 'ZALO', codeVerifier?: string) {
    const state = randomToken(24);
    await this.prisma.oAuthState.create({ data: { workspaceId: ws.workspaceId, userId: ws.userId, provider, stateHash: sha256Hex(state), codeVerifier: codeVerifier ? encrypt(codeVerifier) : null, expiresAt: new Date(Date.now() + 15 * 60_000) } });
    return state;
  }

  private async takeState(state: string | undefined, provider: 'FACEBOOK' | 'ZALO') {
    if (!state) return null;
    const row = await this.prisma.oAuthState.findUnique({ where: { stateHash: sha256Hex(state) } });
    if (!row || row.provider !== provider || row.expiresAt < new Date()) return null;
    return row;
  }

  // ---------- Facebook Login → chọn Page ----------

  @Roles('OWNER')
  @Get('channels/facebook/connect-url')
  async fbConnectUrl(@Ws() ws: WorkspaceCtx) {
    const c = config();
    if (!c.META_APP_ID || !c.META_APP_SECRET) throw new AppError('META_NOT_CONFIGURED', 'Chưa cấu hình META_APP_ID / META_APP_SECRET trên máy chủ');
    if (ws.isDemo) throw new AppError('DEMO', 'Workspace demo chỉ dùng kênh mô phỏng');
    const state = await this.newState(ws, 'FACEBOOK');
    const redirect = `${c.PUBLIC_API_URL}/api/oauth/facebook/callback`;
    const url = `${c.META_OAUTH_DIALOG}/${c.META_GRAPH_VERSION}/dialog/oauth?client_id=${c.META_APP_ID}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}&response_type=code&scope=${FB_SCOPES.join(',')}`;
    return { url };
  }

  @Public()
  @Get('oauth/facebook/callback')
  async fbCallback(@Query('code') code: string, @Query('state') state: string, @Query('error_description') err: string, @Res() res: Response) {
    const c = config();
    const back = (q: string) => res.redirect(`${c.APP_URL}/channels?${q}`);
    const row = await this.takeState(state, 'FACEBOOK');
    if (!row) return back('error=' + encodeURIComponent('Phiên cấp quyền không hợp lệ hoặc đã hết hạn'));
    if (!code) return back('error=' + encodeURIComponent(err || 'Người dùng huỷ cấp quyền'));
    const base = `${c.META_GRAPH_BASE}/${c.META_GRAPH_VERSION}`;
    const redirect = `${c.PUBLIC_API_URL}/api/oauth/facebook/callback`;
    const short = await platformFetch(`${base}/oauth/access_token?client_id=${c.META_APP_ID}&redirect_uri=${encodeURIComponent(redirect)}&client_secret=${c.META_APP_SECRET}&code=${encodeURIComponent(code)}`);
    if (short.kind !== 'response' || !short.body?.access_token) return back('error=' + encodeURIComponent('Không đổi được mã cấp quyền Facebook'));
    const long = await platformFetch(`${base}/oauth/access_token?grant_type=fb_exchange_token&client_id=${c.META_APP_ID}&client_secret=${c.META_APP_SECRET}&fb_exchange_token=${encodeURIComponent(short.body.access_token)}`);
    const userToken = long.kind === 'response' && long.body?.access_token ? long.body.access_token : short.body.access_token;
    const pages = await platformFetch(`${base}/me/accounts?fields=id,name,access_token,tasks,picture&limit=100&access_token=${encodeURIComponent(userToken)}`);
    if (pages.kind !== 'response' || !Array.isArray(pages.body?.data)) return back('error=' + encodeURIComponent('Không lấy được danh sách Page'));
    await this.prisma.oAuthState.update({ where: { id: row.id }, data: { payloadEnc: encrypt(JSON.stringify(pages.body.data)) } });
    return back(`connect=facebook&state=${encodeURIComponent(state)}`);
  }

  @Roles('OWNER')
  @Get('channels/facebook/pages')
  async fbPages(@Ws() ws: WorkspaceCtx, @Query('state') state: string) {
    const row = await this.takeState(state, 'FACEBOOK');
    if (!row || row.workspaceId !== ws.workspaceId || row.userId !== ws.userId || !row.payloadEnc) throw new AppError('INVALID_STATE', 'Phiên chọn Page không hợp lệ hoặc đã hết hạn');
    const pages = JSON.parse(decrypt(row.payloadEnc)) as any[];
    return { items: pages.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks ?? [], picture: p.picture?.data?.url, canMessage: (p.tasks ?? []).includes('MESSAGING') || (p.tasks ?? []).includes('MANAGE') })) };
  }

  @Roles('OWNER')
  @Post('channels/facebook/pages')
  async fbConnectPages(@Ws() ws: WorkspaceCtx, @Body() body: { state: string; pageIds: string[] }) {
    const row = await this.takeState(body.state, 'FACEBOOK');
    if (!row || row.workspaceId !== ws.workspaceId || row.userId !== ws.userId || !row.payloadEnc) throw new AppError('INVALID_STATE', 'Phiên chọn Page không hợp lệ hoặc đã hết hạn');
    const pages = (JSON.parse(decrypt(row.payloadEnc)) as any[]).filter((p) => body.pageIds?.includes(p.id));
    const results = [];
    for (const p of pages) {
      try {
        const ch = await this.upsertChannel(ws.workspaceId, 'FACEBOOK', p.id, p.name);
        await this.credentials.store(ch.id, ws.workspaceId, { accessToken: p.access_token, scopes: FB_SCOPES });
        const sub = await this.adapters.facebook.subscribePage(p.id, p.access_token);
        const subOk = sub.kind === 'response' && (sub.body?.success === true || sub.body?.success === 'true');
        const verify = await this.verify(ch.id);
        results.push({ pageId: p.id, name: p.name, ok: verify.ok && subOk, message: subOk ? verify.message : `Đăng ký webhook thất bại: ${sub.kind === 'response' ? sub.body?.error?.message ?? sub.status : sub.kind}` });
      } catch (e: any) {
        results.push({ pageId: p.id, name: p.name, ok: false, message: e.message });
      }
    }
    await this.prisma.oAuthState.delete({ where: { id: row.id } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'channel.facebook_connected', metadata: { pages: results.map((r) => ({ pageId: r.pageId, ok: r.ok })) } });
    return { results };
  }

  // ---------- Zalo OA (OAuth v4 + PKCE) ----------

  @Roles('OWNER')
  @Get('channels/zalo/connect-url')
  async zaloConnectUrl(@Ws() ws: WorkspaceCtx) {
    const c = config();
    if (!c.ZALO_APP_ID || !c.ZALO_APP_SECRET) throw new AppError('ZALO_NOT_CONFIGURED', 'Chưa cấu hình ZALO_APP_ID / ZALO_APP_SECRET trên máy chủ');
    if (ws.isDemo) throw new AppError('DEMO', 'Workspace demo chỉ dùng kênh mô phỏng');
    const verifier = randomToken(32);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = await this.newState(ws, 'ZALO', verifier);
    const redirect = `${c.PUBLIC_API_URL}/api/oauth/zalo/callback`;
    return { url: `${c.ZALO_OAUTH_BASE}/v4/oa/permission?app_id=${c.ZALO_APP_ID}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&state=${state}` };
  }

  @Public()
  @Get('oauth/zalo/callback')
  async zaloCallback(@Query('code') code: string, @Query('oa_id') oaId: string, @Query('state') state: string, @Res() res: Response) {
    const c = config();
    const back = (q: string) => res.redirect(`${c.APP_URL}/channels?${q}`);
    const row = await this.takeState(state, 'ZALO');
    if (!row) return back('error=' + encodeURIComponent('Phiên cấp quyền không hợp lệ hoặc đã hết hạn'));
    if (!code || !oaId) return back('error=' + encodeURIComponent('Thiếu mã cấp quyền Zalo'));
    const r = await platformFetch(`${c.ZALO_OAUTH_BASE}/v4/oa/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: c.ZALO_APP_SECRET! },
      body: new URLSearchParams({ code, app_id: c.ZALO_APP_ID!, grant_type: 'authorization_code', code_verifier: row.codeVerifier ? decrypt(row.codeVerifier) : '' }).toString(),
    });
    if (r.kind !== 'response' || !r.body?.access_token) {
      return back('error=' + encodeURIComponent(`Không đổi được mã cấp quyền Zalo (${r.kind === 'response' ? r.body?.error ?? r.status : r.kind})`));
    }
    try {
      const ch = await this.upsertChannel(row.workspaceId, 'ZALO', String(oaId), `Zalo OA ${oaId}`);
      await this.credentials.store(ch.id, row.workspaceId, { accessToken: r.body.access_token, refreshToken: r.body.refresh_token, accessExpiresInSec: Number(r.body.expires_in) || null });
      const v = await this.verify(ch.id);
      await this.prisma.oAuthState.delete({ where: { id: row.id } });
      await this.audit.log({ workspaceId: row.workspaceId, actorId: row.userId, action: 'channel.zalo_connected', targetType: 'channel', targetId: ch.id, metadata: { oaId, verified: v.ok } });
      return back(v.ok ? 'connected=zalo' : 'error=' + encodeURIComponent(v.message));
    } catch (e: any) {
      return back('error=' + encodeURIComponent(e.message ?? redactUrl('lỗi')));
    }
  }
}
