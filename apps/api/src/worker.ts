import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MaintenanceService } from './admin/maintenance.service';
import { QueueService } from './common/queue.service';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const queue = app.get(QueueService);
  queue.startWorkers({ webhook: 10, outbound: 5, ai: 3, knowledge: 2, maintenance: 2 });
  await app.get(MaintenanceService).schedule();
  Logger.log('Worker đã khởi động', 'Worker');
}
bootstrap();
