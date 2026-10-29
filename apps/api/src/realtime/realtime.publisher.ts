import { Injectable } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import { config } from '../config';
import { redis } from '../common/redis';

/**
 * Phát sự kiện realtime từ API hoặc worker qua Redis.
 * Phòng (room): ch:<channelId> (người có quyền với kênh), user:<userId>, ws:<workspaceId>:managers.
 */
@Injectable()
export class RealtimePublisher {
  private emitter: Emitter | null = null;
  readonly sent: { rooms: string[]; event: string; payload: any }[] = [];

  private get(): Emitter | null {
    if (config().QUEUE_MODE === 'inline') return null;
    if (!this.emitter) this.emitter = new Emitter(redis());
    return this.emitter;
  }

  emit(rooms: string[], event: string, payload: any) {
    const unique = [...new Set(rooms.filter(Boolean))];
    const e = this.get();
    if (!e) {
      this.sent.push({ rooms: unique, event, payload });
      return;
    }
    e.to(unique).emit(event, payload);
  }

  conversationRooms(c: { workspaceId: string; channelId: string; assigneeId?: string | null }) {
    return [`ch:${c.channelId}`, `ws:${c.workspaceId}:managers`, c.assigneeId ? `user:${c.assigneeId}` : ''];
  }
}
