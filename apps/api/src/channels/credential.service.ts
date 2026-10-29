import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelCredential, Prisma } from '@prisma/client';
import { config } from '../config';
import { decrypt, encrypt } from '../common/crypto';
import { platformFetch } from '../common/http';
import { PrismaService } from '../common/prisma.service';

export class CredentialError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Quản lý token kênh. Với Zalo: access token ngắn hạn, refresh token dùng MỘT lần.
 * Làm mới được tuần tự hoá bằng khoá hàng (SELECT … FOR UPDATE) trên ChannelCredential,
 * nên nhiều worker cùng lúc chỉ có một lần gọi refresh; các tiến trình khác dùng token mới.
 */
@Injectable()
export class CredentialService {
  private readonly log = new Logger('Credential');
  /** Số lần gọi API refresh (để kiểm thử) */
  refreshCalls = 0;

  constructor(private prisma: PrismaService) {}

  async store(channelId: string, workspaceId: string, data: { accessToken: string; refreshToken?: string | null; accessExpiresInSec?: number | null; refreshExpiresInSec?: number | null; scopes?: string[] }) {
    const now = Date.now();
    const values = {
      accessTokenEnc: encrypt(data.accessToken),
      refreshTokenEnc: data.refreshToken ? encrypt(data.refreshToken) : null,
      accessTokenExpiresAt: data.accessExpiresInSec ? new Date(now + data.accessExpiresInSec * 1000) : null,
      refreshTokenExpiresAt: data.refreshExpiresInSec ? new Date(now + data.refreshExpiresInSec * 1000) : null,
      scopes: data.scopes ?? [],
      lastRefreshedAt: new Date(),
    };
    await this.prisma.channelCredential.upsert({
      where: { channelId },
      create: { channelId, workspaceId, ...values },
      update: { ...values, version: { increment: 1 } },
    });
  }

  /** Trả access token còn hạn; tự làm mới Zalo nếu sắp hết hạn (< 5 phút). */
  async accessToken(channel: Channel): Promise<string> {
    if (channel.isSimulated) return 'simulated';
    const cred = await this.prisma.channelCredential.findUnique({ where: { channelId: channel.id } });
    if (!cred) throw new CredentialError('NO_CREDENTIAL', 'Kênh chưa có thông tin cấp quyền');
    if (channel.type === 'ZALO' && cred.accessTokenExpiresAt && cred.accessTokenExpiresAt.getTime() - Date.now() < 5 * 60_000) {
      return this.refreshZalo(channel.id, cred.version);
    }
    return decrypt(cred.accessTokenEnc);
  }

  /**
   * Làm mới token Zalo. observedVersion: phiên bản token mà bên gọi thấy là hỏng/hết hạn.
   * Nếu khi giành được khoá phiên bản đã khác → tiến trình khác vừa làm mới, dùng luôn token đó.
   */
  async refreshZalo(channelId: string, observedVersion: number): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<ChannelCredential[]>(Prisma.sql`SELECT * FROM "ChannelCredential" WHERE "channelId" = ${channelId} FOR UPDATE`);
        const cred = rows[0];
        if (!cred) throw new CredentialError('NO_CREDENTIAL', 'Kênh chưa có thông tin cấp quyền');
        if (cred.version !== observedVersion) return decrypt(cred.accessTokenEnc);
        if (!cred.refreshTokenEnc) throw new CredentialError('NO_REFRESH_TOKEN', 'Không có refresh token. Cần cấp quyền lại.');
        const c = config();
        if (!c.ZALO_APP_ID || !c.ZALO_APP_SECRET) throw new CredentialError('ZALO_NOT_CONFIGURED', 'Chưa cấu hình ZALO_APP_ID / ZALO_APP_SECRET');
        this.refreshCalls++;
        const r = await platformFetch(`${c.ZALO_OAUTH_BASE}/v4/oa/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: c.ZALO_APP_SECRET },
          body: new URLSearchParams({ refresh_token: decrypt(cred.refreshTokenEnc), app_id: c.ZALO_APP_ID, grant_type: 'refresh_token' }).toString(),
        });
        const body = r.kind === 'response' ? r.body : null;
        if (!body?.access_token) {
          const msg = r.kind === 'response' ? `${body?.error ?? r.status}: ${body?.error_description ?? body?.message ?? 'refresh thất bại'}` : r.kind;
          this.log.warn(`Làm mới token Zalo thất bại cho kênh ${channelId}: ${msg}`);
          await tx.channel.update({
            where: { id: channelId },
            data: { status: 'ERROR', lastErrorCode: 'ZALO_REFRESH_FAILED', lastError: 'Không làm mới được token Zalo. Cần cấp quyền lại.', lastErrorAt: new Date() },
          });
          throw new CredentialError('ZALO_REFRESH_FAILED', 'Không làm mới được token Zalo. Cần cấp quyền lại.');
        }
        const now = Date.now();
        await tx.channelCredential.update({
          where: { channelId },
          data: {
            accessTokenEnc: encrypt(body.access_token),
            // refresh token chỉ dùng một lần → luôn lưu refresh token mới
            refreshTokenEnc: body.refresh_token ? encrypt(body.refresh_token) : null,
            accessTokenExpiresAt: body.expires_in ? new Date(now + Number(body.expires_in) * 1000) : null,
            version: { increment: 1 },
            lastRefreshedAt: new Date(),
          },
        });
        return body.access_token as string;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  async currentVersion(channelId: string) {
    return (await this.prisma.channelCredential.findUnique({ where: { channelId }, select: { version: true } }))?.version ?? 0;
  }
}
