import { Injectable } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { randomBytes } from 'crypto';
import { config } from '../../config';
import { redis } from '../../common/redis';
import { ChannelAdapter, OutgoingMessage, SendOutcome, VerifyOutcome } from './types';

export type SimFailure = 'fail' | 'rate_limit' | 'timeout' | 'auth';

/**
 * Adapter mô phỏng cho workspace demo: KHÔNG gọi mạng. Có thể tiêm lỗi gửi để thử
 * các trạng thái thất bại / giới hạn tốc độ / chưa xác định.
 */
@Injectable()
export class SimulatedAdapter implements ChannelAdapter {
  readonly kind = 'simulated' as const;
  private memory = new Map<string, SimFailure[]>();
  readonly sentLog: { channelId: string; msg: OutgoingMessage }[] = [];

  private useMemory() {
    return config().QUEUE_MODE === 'inline';
  }

  async injectFailure(channelId: string, failure: SimFailure) {
    if (this.useMemory()) {
      const arr = this.memory.get(channelId) ?? [];
      arr.push(failure);
      this.memory.set(channelId, arr);
      return;
    }
    await redis().rpush(`sim:fail:${channelId}`, failure);
    await redis().expire(`sim:fail:${channelId}`, 3600);
  }

  private async nextFailure(channelId: string): Promise<SimFailure | null> {
    if (this.useMemory()) return this.memory.get(channelId)?.shift() ?? null;
    return ((await redis().lpop(`sim:fail:${channelId}`)) as SimFailure | null) ?? null;
  }

  async send(channel: Channel, _token: string, msg: OutgoingMessage): Promise<SendOutcome> {
    if (!channel.isSimulated) throw new Error('Adapter mô phỏng chỉ dùng cho kênh mô phỏng');
    const failure = await this.nextFailure(channel.id);
    if (failure === 'fail') return { outcome: 'failed', retryable: false, code: 'SIM_FAIL', message: 'Lỗi gửi mô phỏng' };
    if (failure === 'rate_limit') return { outcome: 'failed', retryable: true, code: 'SIM_RATE_LIMIT', message: 'Giới hạn tốc độ mô phỏng', retryAfterMs: 3000 };
    if (failure === 'timeout') return { outcome: 'unknown', message: 'Hết thời gian chờ (mô phỏng); chưa rõ tin đã gửi hay chưa' };
    if (failure === 'auth') return { outcome: 'failed', retryable: false, code: 'SIM_AUTH', message: 'Token hết hạn (mô phỏng)', authError: true };
    this.sentLog.push({ channelId: channel.id, msg });
    const prefix = channel.type === 'FACEBOOK' ? 'm_sim_' : 'zsim_';
    return { outcome: 'accepted', externalId: prefix + randomBytes(8).toString('hex') };
  }

  async verify(channel: Channel): Promise<VerifyOutcome> {
    return { ok: true, externalId: channel.externalId, name: channel.name, detail: 'Kênh mô phỏng — không kết nối nền tảng thật' };
  }
}
