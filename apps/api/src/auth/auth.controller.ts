import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { PrismaService } from '../common/prisma.service';
import { AuthService } from './auth.service';
import { AuthUser, CurrentUser, NoWorkspace, Public } from './context';
import { SESSION_COOKIE } from './guards';
import { parse } from '../common/validation';

const LoginDto = z.object({ email: z.string().email(), password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService) {}

  @Public()
  @Post('login')
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const dto = parse(LoginDto, body);
    const { token, user } = await this.auth.login(dto.email, dto.password, req.ip ?? 'unknown', req.headers['user-agent']);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config().COOKIE_SECURE,
      maxAge: config().SESSION_TTL_HOURS * 3600_000,
      path: '/',
    });
    return { user };
  }

  @NoWorkspace()
  @Post('logout')
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @NoWorkspace()
  @Post('logout-others')
  async logoutOthers(@CurrentUser() user: AuthUser) {
    await this.auth.revokeOtherSessions(user.id, user.sessionId);
    return { ok: true };
  }

  @NoWorkspace()
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { id: true, name: true, slug: true, isDemo: true, timezone: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name },
      workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
    };
  }
}
