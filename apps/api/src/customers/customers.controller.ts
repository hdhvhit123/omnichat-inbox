import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../auth/access.service';
import { ADMIN_ROLES, Roles, WRITE_ROLES, Ws, WorkspaceCtx } from '../auth/context';
import { AppError, notFound } from '../common/errors';
import { normalizeVi, normalizeVnPhone } from '../common/text';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../admin/audit.service';
import { StorageService } from '../files/storage.service';

const UpdateDto = z.object({
  displayName: z.string().min(1).max(200).optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  tagIds: z.array(z.string()).optional(),
});
const MergeDto = z.object({ sourceId: z.string(), targetId: z.string(), reason: z.string().min(5).max(500), evidence: z.string().max(1000).optional() });

@Controller('customers')
export class CustomersController {
  constructor(private prisma: PrismaService, private access: AccessService, private audit: AuditService, private storage: StorageService) {}

  /** Khách hàng chỉ hiển thị nếu người dùng thấy ít nhất một hội thoại của họ. */
  private customerWhere(ws: WorkspaceCtx): Prisma.CustomerWhereInput {
    const base: Prisma.CustomerWhereInput = { workspaceId: ws.workspaceId, mergedIntoId: null };
    if (ws.channelIds === 'all') return base;
    return { ...base, conversations: { some: this.access.conversationWhere(ws) } };
  }

  @Get()
  async list(@Ws() ws: WorkspaceCtx, @Query('q') q?: string, @Query('cursor') cursor?: string) {
    const and: Prisma.CustomerWhereInput[] = [this.customerWhere(ws)];
    if (q) and.push({ OR: [{ searchText: { contains: normalizeVi(q) } }, { phone: { contains: q.replace(/\s/g, '') } }, { email: { contains: q.toLowerCase() } }] });
    const rows = await this.prisma.customer.findMany({
      where: { AND: and },
      include: { identities: { include: { channel: { select: { type: true, name: true } } } }, tags: { include: { tag: true } }, _count: { select: { conversations: true } } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 31,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, 30).map((c) => ({ ...c, searchText: undefined, tags: c.tags.map((t) => t.tag) }));
    return { items, nextCursor: rows.length > 30 ? items[items.length - 1].id : null };
  }

  @Get(':id')
  async get(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const c = await this.prisma.customer.findFirst({
      where: { AND: [{ id }, this.customerWhere(ws)] },
      include: {
        identities: { include: { channel: { select: { id: true, type: true, name: true } } } },
        tags: { include: { tag: true } },
        conversations: { where: this.access.conversationWhere(ws), select: { id: true, status: true, lastMessageAt: true, lastMessagePreview: true, channel: { select: { type: true, name: true } } }, orderBy: { lastMessageAt: 'desc' } },
      },
    });
    if (!c) throw notFound('Khách hàng');
    const links = await this.prisma.customerLinkEvent.findMany({ where: { workspaceId: ws.workspaceId, OR: [{ fromCustomerId: id }, { toCustomerId: id }] }, orderBy: { createdAt: 'desc' } });
    return { customer: { ...c, searchText: undefined, tags: c.tags.map((t) => t.tag) }, links };
  }

  @Roles(...WRITE_ROLES)
  @Patch(':id')
  async update(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(UpdateDto, body);
    const c = await this.prisma.customer.findFirst({ where: { AND: [{ id }, this.customerWhere(ws)] } });
    if (!c) throw notFound('Khách hàng');
    let phone = dto.phone;
    if (phone) {
      const n = normalizeVnPhone(phone);
      if (!n) throw new AppError('VALIDATION', 'Số điện thoại không hợp lệ');
      phone = n;
    }
    const name = dto.displayName ?? c.displayName;
    await this.prisma.customer.update({
      where: { id },
      data: { displayName: dto.displayName, phone, email: dto.email, notes: dto.notes, searchText: normalizeVi(`${name} ${dto.email ?? c.email ?? ''}`) },
    });
    if (dto.tagIds) {
      const tags = await this.prisma.tag.findMany({ where: { workspaceId: ws.workspaceId, id: { in: dto.tagIds } } });
      await this.prisma.$transaction([
        this.prisma.customerTag.deleteMany({ where: { customerId: id } }),
        this.prisma.customerTag.createMany({ data: tags.map((t) => ({ customerId: id, tagId: t.id })) }),
      ]);
    }
    return this.get(ws, id);
  }

  /**
   * Gộp hồ sơ (liên kết đa kênh): chỉ thực hiện khi người có quyền xác nhận, kèm lý do/căn cứ.
   * Hệ thống không tự gộp dựa trên tên hay ảnh trùng.
   */
  @Roles(...ADMIN_ROLES)
  @Post('merge')
  async merge(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(MergeDto, body);
    if (dto.sourceId === dto.targetId) throw new AppError('VALIDATION', 'Hai hồ sơ phải khác nhau');
    const [src, dst] = await Promise.all([
      this.prisma.customer.findFirst({ where: { id: dto.sourceId, workspaceId: ws.workspaceId, mergedIntoId: null } }),
      this.prisma.customer.findFirst({ where: { id: dto.targetId, workspaceId: ws.workspaceId, mergedIntoId: null } }),
    ]);
    if (!src || !dst) throw notFound('Khách hàng');
    await this.prisma.$transaction([
      this.prisma.customerIdentity.updateMany({ where: { customerId: src.id }, data: { customerId: dst.id } }),
      this.prisma.conversation.updateMany({ where: { customerId: src.id }, data: { customerId: dst.id } }),
      this.prisma.customer.update({ where: { id: dst.id }, data: { phone: dst.phone ?? src.phone, email: dst.email ?? src.email } }),
      this.prisma.customer.update({ where: { id: src.id }, data: { mergedIntoId: dst.id } }),
      this.prisma.customerLinkEvent.create({ data: { workspaceId: ws.workspaceId, fromCustomerId: src.id, toCustomerId: dst.id, actorId: ws.userId, action: 'MERGE', reason: dto.reason, evidence: dto.evidence } }),
    ]);
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'customer.merged', targetType: 'customer', targetId: dst.id, metadata: { from: src.id, reason: dto.reason } });
    return { ok: true, customerId: dst.id };
  }

  /** Xoá dữ liệu khách hàng (hồ sơ, hội thoại, tin nhắn, tệp đính kèm). Không thể hoàn tác. */
  @Roles('OWNER')
  @Delete(':id')
  async remove(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Query('confirm') confirm?: string) {
    if (confirm !== 'DELETE') throw new AppError('CONFIRM_REQUIRED', 'Cần xác nhận xoá (confirm=DELETE)');
    const c = await this.prisma.customer.findFirst({ where: { id, workspaceId: ws.workspaceId } });
    if (!c) throw notFound('Khách hàng');
    const msgs = await this.prisma.message.findMany({ where: { conversation: { customerId: id } }, select: { attachments: true } });
    const fileIds = msgs.flatMap((m) => ((m.attachments as any[] | null) ?? []).map((a) => a.fileId)).filter(Boolean);
    const files = await this.prisma.fileObject.findMany({ where: { id: { in: fileIds }, workspaceId: ws.workspaceId } });
    for (const f of files) await this.storage.delete(f.storageKey).catch(() => undefined);
    await this.prisma.$transaction([
      this.prisma.fileObject.deleteMany({ where: { id: { in: files.map((f) => f.id) } } }),
      this.prisma.customer.deleteMany({ where: { OR: [{ id }, { mergedIntoId: id }], workspaceId: ws.workspaceId } }),
    ]);
    await this.audit.log({ workspaceId: ws.workspaceId, actorId: ws.userId, action: 'customer.deleted', targetType: 'customer', targetId: id, metadata: { files: files.length } });
    return { ok: true };
  }
}
