import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { WorkspaceCtx } from './context';

/** Tập trung điều kiện truy cập dữ liệu hội thoại theo workspace + phạm vi kênh. */
@Injectable()
export class AccessService {
  constructor(private prisma: PrismaService) {}

  conversationWhere(ws: WorkspaceCtx): Prisma.ConversationWhereInput {
    if (ws.channelIds === 'all') return { workspaceId: ws.workspaceId };
    const or: Prisma.ConversationWhereInput[] = [{ channelId: { in: ws.channelIds } }];
    if (ws.role === 'AGENT') or.push({ assigneeId: ws.userId });
    return { workspaceId: ws.workspaceId, OR: or };
  }

  channelWhere(ws: WorkspaceCtx): Prisma.ChannelWhereInput {
    if (ws.channelIds === 'all') return { workspaceId: ws.workspaceId };
    return { workspaceId: ws.workspaceId, id: { in: ws.channelIds } };
  }

  async getConversation(ws: WorkspaceCtx, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { AND: [{ id }, this.conversationWhere(ws)] } });
    if (!c) throw notFound('Hội thoại');
    return c;
  }

  async canAccessConversation(ws: WorkspaceCtx, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { AND: [{ id }, this.conversationWhere(ws)] }, select: { id: true } });
    return !!c;
  }
}
