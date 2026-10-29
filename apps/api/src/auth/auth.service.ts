import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { randomToken, sha256Hex } from '../common/crypto';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { redis } from '../common/redis';
import { AuditService } from '../admin/audit.service';
import { AuthUser, WorkspaceCtx } from './context';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const IP_LIMIT_PER_15M = 30;

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async hashPassword(pw: string) {
    if (pw.length < 8) throw new AppError('WEAK_PASSWORD', 'Mật khẩu cần tối thiểu 8 ký tự');
    return bcrypt.hash(pw, 12);
  }

  private async ipRateLimit(ip: string) {
    if (config().QUEUE_MODE === 'inline') return; // kiểm thử không phụ thuộc Redis
    const key = `login:ip:${ip}`;
    const n = await redis().incr(key);
    if (n === 1) await redis().expire(key, 15 * 60);
    if (n > IP_LIMIT_PER_15M) throw new AppError('RATE_LIMITED', 'Quá nhiều lần đăng nhập. Vui lòng thử lại sau 15 phút.', 429);
  }

  async login(email: string, password: string, ip: string, userAgent?: string) {
    await this.ipRateLimit(ip);
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    const generic = new AppError('INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng', 401);
    if (!user) {
      await bcrypt.compare(password, '$2a$12$abcdefghijklmnopqrstuuJ0aC0S0nZQ9b0c1d2e3f4g5h6i7j8k9'); // cân bằng thời gian
      throw generic;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError('ACCOUNT_LOCKED', 'Tài khoản tạm khoá do đăng nhập sai nhiều lần. Vui lòng thử lại sau.', 423);
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: failed >= MAX_FAILED ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : { failedLoginCount: failed },
      });
      await this.audit.log({ actorId: user.id, action: 'auth.login_failed', ip });
      throw generic;
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    const token = randomToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(token),
        ip,
        userAgent: userAgent?.slice(0, 300),
        expiresAt: new Date(Date.now() + config().SESSION_TTL_HOURS * 3600_000),
      },
    });
    await this.audit.log({ actorId: user.id, action: 'auth.login', ip });
    return { token, user: { id: user.id, email: user.email, name: user.name } };
  }

  async validateSession(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    const s = await this.prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
    if (!s || s.revokedAt || s.expiresAt < new Date()) return null;
    if (Date.now() - s.lastSeenAt.getTime() > 5 * 60_000) {
      await this.prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
    }
    return { id: s.user.id, email: s.user.email, name: s.user.name, sessionId: s.id };
  }

  async logout(sessionId: string) {
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  async revokeOtherSessions(userId: string, keepSessionId: string) {
    await this.prisma.session.updateMany({ where: { userId, id: { not: keepSessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async workspaceContext(userId: string, workspaceId: string): Promise<WorkspaceCtx | null> {
    const m = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { channelAccess: true, workspace: true },
    });
    if (!m) return null;
    let channelIds: 'all' | string[] = 'all';
    if (m.role === 'AGENT' || (m.role === 'VIEWER' && m.channelAccess.length > 0)) {
      channelIds = m.channelAccess.map((a) => a.channelId);
    }
    return { workspaceId, role: m.role, membershipId: m.id, userId, isDemo: m.workspace.isDemo, channelIds };
  }
}
