import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { Roles, Ws, WorkspaceCtx } from '../auth/context';
import { randomToken } from '../common/crypto';
import { AppError, notFound } from '../common/errors';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../admin/audit.service';

const InviteDto = z.object({ email: z.string().email(), name: z.string().min(1).max(100), role: z.enum(['MANAGER', 'AGENT', 'VIEWER', 'OWNER']), channelIds: z.array(z.string()).default([]) });
const UpdateDto = z.object({ role: z.enum(['OWNER', 'MANAGER', 'AGENT', 'VIEWER']).optional(), channelIds: z.array(z.string()).optional() });

@Controller('members')
export class MembersController {
  constructor(private prisma: PrismaService, private auth: AuthService, private audit: AuditService) {}

  @Get()
  async list(@Ws() ws: WorkspaceCtx) {
    const rows = await this.prisma.membership.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { user: { select: { id: true, email: true, name: true } }, channelAccess: true },
      orderBy: { createdAt: 'asc' },
    });
    return { items: rows.map((m) => ({ id: m.id, role: m.role, user: m.user, channelIds: m.channelAccess.map((a) => a.channelId), createdAt: m.createdAt })) };
  }

  /** Thêm thành viên. Nếu email chưa có tài khoản: tạo tài khoản với mật khẩu tạm (hiển thị một lần). */
  @Roles('OWNER')
  @Post()
  async invite(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(InviteDto, body);
    const email = dto.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    let tempPassword: string | null = null;
    if (!user) {
      tempPassword = randomToken(9);
      user = await this.prisma.user.create({ data: { email, name: dto.name, passwordHash: await this.auth.hashPassword(tempPassword) } });
    }
    const exists = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.workspaceId, userId: user.id } } });
    if (exists) throw new AppError('ALREADY_MEMBER', 'Người này đã là thành viên');
    const channels = await this.prisma.channel.findMany({ where: { workspaceId: ws.workspaceId, id: { in: dto.channelIds } } });
    const m = await this.prisma.membership.create({ data: { workspaceId: ws.workspaceId, userId: user.id, role: dto.role, channelAccess: { create: channels.map((c) => ({ channelId: c.id })) } } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'member.added', targetType: 'membership', targetId: m.id, metadata: { email, role: dto.role } });
    return { membershipId: m.id, tempPassword };
  }

  @Roles('OWNER')
  @Patch(':id')
  async update(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(UpdateDto, body);
    const m = await this.prisma.membership.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!m) throw notFound('Thành viên');
    if (dto.role && m.role === 'OWNER' && dto.role !== 'OWNER') {
      const owners = await this.prisma.membership.count({ where: { workspaceId: ws.workspaceId, role: 'OWNER' } });
      if (owners <= 1) throw new AppError('LAST_OWNER', 'Workspace cần ít nhất một Chủ sở hữu');
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.role) await tx.membership.update({ where: { id }, data: { role: dto.role } });
      if (dto.channelIds) {
        const channels = await tx.channel.findMany({ where: { workspaceId: ws.workspaceId, id: { in: dto.channelIds } } });
        await tx.memberChannelAccess.deleteMany({ where: { membershipId: id } });
        await tx.memberChannelAccess.createMany({ data: channels.map((c) => ({ membershipId: id, channelId: c.id })) });
      }
    });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'member.updated', targetType: 'membership', targetId: id, metadata: dto });
    return { ok: true };
  }

  @Roles('OWNER')
  @Delete(':id')
  async remove(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const m = await this.prisma.membership.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!m) throw notFound('Thành viên');
    if (m.userId === ws.userId) throw new AppError('SELF', 'Không thể tự xoá chính mình');
    if (m.role === 'OWNER') {
      const owners = await this.prisma.membership.count({ where: { workspaceId: ws.workspaceId, role: 'OWNER' } });
      if (owners <= 1) throw new AppError('LAST_OWNER', 'Workspace cần ít nhất một Chủ sở hữu');
    }
    await this.prisma.membership.delete({ where: { id } });
    await this.prisma.conversation.updateMany({ where: { workspaceId: ws.workspaceId, assigneeId: m.userId }, data: { assigneeId: null } });
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'member.removed', targetType: 'membership', targetId: id });
    return { ok: true };
  }
}
