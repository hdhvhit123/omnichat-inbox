import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { QUEUES, QueueService } from '../common/queue.service';
import { CredentialService } from '../channels/credential.service';
import { SimulatorService } from '../demo/simulator.service';
import { OutboxProcessor } from '../outbox/outbox.processor';

/** Tác vụ định kỳ của worker. */
@Injectable()
export class MaintenanceService {
  private readonly log = new Logger('Maintenance');
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private credentials: CredentialService,
    private outbox: OutboxProcessor,
    private simulator: SimulatorService,
  ) {}

  register() {
    this.queue.register(QUEUES.maintenance, async (data: any) => {
      switch (data?.task) {
        case 'sim-receipt':
          return this.simulator.receipt(data);
        case 'outbox-sweep':
          return this.outbox.sweep();
        case 'webhook-sweep':
          return this.webhookSweep();
        case 'zalo-token-refresh':
          return this.refreshExpiringZalo();
        case 'retention':
          return this.retention();
      }
    });
  }

  async schedule() {
    await this.queue.repeat(QUEUES.maintenance, 'outbox-sweep', 60_000);
    await this.queue.repeat(QUEUES.maintenance, 'webhook-sweep', 60_000);
    await this.queue.repeat(QUEUES.maintenance, 'zalo-token-refresh', 10 * 60_000);
    await this.queue.repeat(QUEUES.maintenance, 'retention', 6 * 3600_000);
  }

  /** Sự kiện đã lưu nhưng chưa vào hàng đợi (ví dụ Redis gián đoạn) → đẩy lại. */
  async webhookSweep() {
    const stuck = await this.prisma.webhookEvent.findMany({ where: { status: 'RECEIVED', receivedAt: { lt: new Date(Date.now() - 2 * 60_000) }, attempts: { lt: 8 } }, take: 200 });
    for (const ev of stuck) await this.queue.add(QUEUES.webhook, { webhookEventId: ev.id }, { jobId: `${ev.id}-sweep-${ev.attempts}`, attempts: 3 });
  }

  /** Làm mới chủ động token Zalo sắp hết hạn (khoá hàng đảm bảo chỉ một tiến trình làm mới). */
  async refreshExpiringZalo() {
    const soon = await this.prisma.channelCredential.findMany({
      where: { channel: { type: 'ZALO', isSimulated: false, status: { in: ['CONNECTED', 'ERROR'] } }, refreshTokenEnc: { not: null }, accessTokenExpiresAt: { lt: new Date(Date.now() + 30 * 60_000) } },
    });
    for (const c of soon) {
      try {
        await this.credentials.refreshZalo(c.channelId, c.version);
      } catch (e: any) {
        this.log.warn(`Không làm mới được token Zalo kênh ${c.channelId}: ${e.message}`);
      }
    }
  }

  /** Xoá dữ liệu quá thời gian lưu cấu hình theo workspace. */
  async retention() {
    const wss = await this.prisma.workspace.findMany({ where: { retentionDays: { not: null } } });
    for (const w of wss) {
      const cutoff = new Date(Date.now() - w.retentionDays! * 86400_000);
      const r = await this.prisma.conversation.deleteMany({ where: { workspaceId: w.id, lastMessageAt: { lt: cutoff }, status: 'RESOLVED' } });
      await this.prisma.webhookEvent.deleteMany({ where: { workspaceId: w.id, receivedAt: { lt: cutoff } } });
      if (r.count) await this.prisma.auditLog.create({ data: { workspaceId: w.id, action: 'retention.purged', metadata: { conversations: r.count, cutoff: cutoff.toISOString() } } });
    }
    await this.prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
  }
}
