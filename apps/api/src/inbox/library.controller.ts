import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ADMIN_ROLES, Roles, Ws, WorkspaceCtx } from '../auth/context';
import { notFound } from '../common/errors';
import { parse } from '../common/validation';
import { PrismaService } from '../common/prisma.service';

const TagDto = z.object({ name: z.string().min(1).max(50), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
const CannedDto = z.object({ shortcut: z.string().min(1).max(30).regex(/^[\p{L}\p{N}_-]+$/u), title: z.string().min(1).max(100), body: z.string().min(1).max(2000) });

/** Nhãn và câu trả lời mẫu. */
@Controller()
export class LibraryController {
  constructor(private prisma: PrismaService) {}

  @Get('tags')
  async tags(@Ws() ws: WorkspaceCtx) {
    return { items: await this.prisma.tag.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { name: 'asc' } }) };
  }

  @Roles(...ADMIN_ROLES)
  @Post('tags')
  async createTag(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(TagDto, body);
    return { tag: await this.prisma.tag.upsert({ where: { workspaceId_name: { workspaceId: ws.workspaceId, name: dto.name } }, create: { workspaceId: ws.workspaceId, ...dto }, update: { color: dto.color } }) };
  }

  @Roles(...ADMIN_ROLES)
  @Delete('tags/:id')
  async deleteTag(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const r = await this.prisma.tag.deleteMany({ where: { id, workspaceId: ws.workspaceId } });
    if (!r.count) throw notFound('Nhãn');
    return { ok: true };
  }

  @Get('canned')
  async canned(@Ws() ws: WorkspaceCtx) {
    return { items: await this.prisma.cannedResponse.findMany({ where: { workspaceId: ws.workspaceId }, orderBy: { shortcut: 'asc' } }) };
  }

  @Roles(...ADMIN_ROLES)
  @Post('canned')
  async createCanned(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    const dto = parse(CannedDto, body);
    return { item: await this.prisma.cannedResponse.create({ data: { workspaceId: ws.workspaceId, ...dto } }) };
  }

  @Roles(...ADMIN_ROLES)
  @Patch('canned/:id')
  async updateCanned(@Ws() ws: WorkspaceCtx, @Param('id') id: string, @Body() body: unknown) {
    const dto = parse(CannedDto.partial(), body);
    const r = await this.prisma.cannedResponse.updateMany({ where: { id, workspaceId: ws.workspaceId }, data: dto });
    if (!r.count) throw notFound('Câu trả lời mẫu');
    return { ok: true };
  }

  @Roles(...ADMIN_ROLES)
  @Delete('canned/:id')
  async deleteCanned(@Ws() ws: WorkspaceCtx, @Param('id') id: string) {
    const r = await this.prisma.cannedResponse.deleteMany({ where: { id, workspaceId: ws.workspaceId } });
    if (!r.count) throw notFound('Câu trả lời mẫu');
    return { ok: true };
  }
}
