import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { config } from '../config';
import { newRedisConnection } from './redis';

export const QUEUES = {
  webhook: 'webhook',
  outbound: 'outbound',
  ai: 'ai',
  knowledge: 'knowledge',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

type Handler = (data: any, job?: Job) => Promise<void>;

export interface AddOptions {
  jobId?: string;
  delayMs?: number;
  attempts?: number;
}

/**
 * Lớp bọc BullMQ. Ở chế độ inline (kiểm thử), job chạy ngay trong tiến trình
 * để kết quả có thể kiểm chứng xác định; job trễ (delay) được ghi lại, không tự chạy.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly log = new Logger('Queue');
  private queues = new Map<string, Queue>();
  private workers: Worker[] = [];
  private handlers = new Map<string, Handler>();
  readonly delayed: { queue: string; data: any; delayMs: number }[] = [];
  readonly inlineErrors: { queue: string; error: unknown }[] = [];

  get inline() {
    return config().QUEUE_MODE === 'inline';
  }

  register(queue: QueueName, handler: Handler) {
    this.handlers.set(queue, handler);
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: newRedisConnection() });
      this.queues.set(name, q);
    }
    return q;
  }

  async add(queue: QueueName, data: any, opts: AddOptions = {}): Promise<void> {
    if (this.inline) {
      if (opts.delayMs && opts.delayMs > 0) {
        this.delayed.push({ queue, data, delayMs: opts.delayMs });
        return;
      }
      const h = this.handlers.get(queue);
      if (!h) return;
      try {
        await h(data);
      } catch (error) {
        this.inlineErrors.push({ queue, error });
      }
      return;
    }
    await this.queue(queue).add(queue, data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: opts.attempts ?? 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      // Job thất bại hết số lần thử được giữ lại = dead-letter, xem ở trang Nhật ký
      removeOnFail: false,
    });
  }

  async repeat(queue: QueueName, name: string, everyMs: number) {
    if (this.inline) return;
    await this.queue(queue).upsertJobScheduler(name, { every: everyMs }, { name, data: { task: name } });
  }

  startWorkers(concurrency: Partial<Record<QueueName, number>> = {}) {
    for (const [name, handler] of this.handlers) {
      const w = new Worker(name, async (job) => handler(job.data, job), {
        connection: newRedisConnection(),
        concurrency: concurrency[name as QueueName] ?? 5,
      });
      w.on('failed', (job, err) => this.log.warn(`Job ${name}#${job?.id} thất bại (lần ${job?.attemptsMade}): ${err.message}`));
      this.workers.push(w);
    }
  }

  async failedJobs(queue: QueueName, limit = 50) {
    if (this.inline) return [];
    const jobs = await this.queue(queue).getFailed(0, limit - 1);
    return jobs.map((j) => ({ id: j.id, queue, data: j.data, failedReason: j.failedReason, attemptsMade: j.attemptsMade, timestamp: j.timestamp }));
  }

  async retryFailed(queue: QueueName, jobId: string) {
    const job = await this.queue(queue).getJob(jobId);
    if (job) await job.retry();
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
