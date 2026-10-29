import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { parse as parseCookie } from 'cookie';
import type { Server, Socket } from 'socket.io';
import { config } from '../config';
import { AccessService } from '../auth/access.service';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/guards';
import { PrismaService } from '../common/prisma.service';

/**
 * WebSocket: xác thực bằng cookie phiên; chỉ vào phòng của kênh mà người dùng được cấp quyền.
 * Mọi sự kiện gửi từ client (đang xem / đang soạn) đều kiểm tra quyền với hội thoại.
 */
@WebSocketGateway({
  path: '/socket.io',
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, !origin || config().CORS_ORIGINS.split(',').map((s) => s.trim()).includes(origin)),
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly log = new Logger('Realtime');
  @WebSocketServer() server: Server;

  constructor(private auth: AuthService, private access: AccessService, private prisma: PrismaService) {}

  async handleConnection(socket: Socket) {
    const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
    const user = await this.auth.validateSession(cookies[SESSION_COOKIE]);
    if (!user) {
      socket.emit('auth.error', { message: 'Phiên đăng nhập không hợp lệ' });
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;
    await socket.join(`user:${user.id}`);
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: { workspaceId: string }) {
    const user = socket.data.user;
    if (!user || !body?.workspaceId) return { ok: false };
    const ws = await this.auth.workspaceContext(user.id, body.workspaceId);
    if (!ws) return { ok: false, message: 'Không có quyền với workspace' };
    // Rời phòng của workspace cũ
    for (const room of socket.rooms) if (room !== socket.id && room !== `user:${user.id}`) await socket.leave(room);
    const channels = await this.prisma.channel.findMany({ where: this.access.channelWhere(ws), select: { id: true } });
    await socket.join(channels.map((c) => `ch:${c.id}`));
    if (ws.role === 'OWNER' || ws.role === 'MANAGER') await socket.join(`ws:${ws.workspaceId}:managers`);
    socket.data.ws = ws;
    return { ok: true, channels: channels.length };
  }

  private async allowed(socket: Socket, conversationId: string) {
    const ws = socket.data.ws;
    if (!ws || !conversationId) return null;
    return (await this.access.canAccessConversation(ws, conversationId)) ? ws : null;
  }

  @SubscribeMessage('viewing')
  async viewing(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId: string }) {
    const ws = await this.allowed(socket, body?.conversationId);
    if (!ws) return { ok: false };
    const c = await this.prisma.conversation.findUniqueOrThrow({ where: { id: body.conversationId }, select: { channelId: true, workspaceId: true, assigneeId: true } });
    this.server.to([`ch:${c.channelId}`, `ws:${c.workspaceId}:managers`]).emit('agent.viewing', { conversationId: body.conversationId, userId: socket.data.user.id, name: socket.data.user.name, at: Date.now() });
    return { ok: true };
  }

  @SubscribeMessage('typing')
  async typing(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId: string }) {
    const ws = await this.allowed(socket, body?.conversationId);
    if (!ws || ws.role === 'VIEWER') return { ok: false };
    const c = await this.prisma.conversation.findUniqueOrThrow({ where: { id: body.conversationId }, select: { channelId: true, workspaceId: true } });
    socket.to([`ch:${c.channelId}`, `ws:${c.workspaceId}:managers`]).emit('agent.typing', { conversationId: body.conversationId, userId: socket.data.user.id, name: socket.data.user.name, at: Date.now() });
    return { ok: true };
  }
}
