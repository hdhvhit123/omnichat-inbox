import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { NormalizedEvent } from './types';

/**
 * Lưu sự kiện webhook bền vững (chống trùng bằng unique provider + kênh + eventKey)
 * rồi đẩy vào hàng đợi. Không xử lý nghiệp vụ trong request webhook.
 */
@Injectable()
export class WebhookIngestService {
  private readonly log = new Logger('WebhookIngest');
  constructor(private prisma: PrismaService, private queue: QueueService) {}

  async ingest(events: NormalizedEvent[]): Promise<{ stored: number; duplicates: number; unrouted: number }> {
    let stored = 0;
    let duplicates = 0;
    let unrouted = 0;
    for (const ev of events) {
      const channel = await this.resolveChannel(ev.provider, ev.channelCandidates);
      if (!channel) {
        unrouted++;
        this.log.warn(`Webhook ${ev.provider} không khớp kênh nào (${ev.channelCandidates.join(',')})`);
        continue;
      }
      try {
        const row = await this.prisma.webhookEvent.create({
          data: {
            provider: ev.provider,
            channelExternalId: channel.externalId,
            eventKey: ev.eventKey.slice(0, 500),
            eventType: ev.type,
            workspaceId: channel.workspaceId,
            payload: JSON.parse(JSON.stringify({ ...ev, channelExternalId: channel.externalId })) as Prisma.InputJsonValue,
            status: ev.type === 'ignored' ? 'IGNORED' : 'RECEIVED',
          },
        });
        stored++;
        await this.prisma.channel.update({ where: { id: channel.id }, data: { lastWebhookAt: new Date() } });
        if (ev.type !== 'ignored') await this.queue.add(QUEUES.webhook, { webhookEventId: row.id }, { jobId: row.id, attempts: 8 });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          duplicates++;
          continue;
        }
        throw e;
      }
    }
    return { stored, duplicates, unrouted };
  }

  private async resolveChannel(provider: ChannelType, candidates: string[]) {
    if (!candidates.length) return null;
    return this.prisma.channel.findFirst({ where: { type: provider, externalId: { in: candidates }, status: { not: 'DISCONNECTED' } } });
  }
}
