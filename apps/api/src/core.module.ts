import { Global, Module, OnModuleInit } from '@nestjs/common';
import { AuditService } from './admin/audit.service';
import { MaintenanceService } from './admin/maintenance.service';
import { AiService } from './ai/ai.service';
import { KnowledgeService } from './ai/knowledge.service';
import { AccessService } from './auth/access.service';
import { AuthService } from './auth/auth.service';
import { AdapterRegistry } from './channels/adapters/adapter.registry';
import { FacebookAdapter } from './channels/adapters/facebook.adapter';
import { SimulatedAdapter } from './channels/adapters/simulated.adapter';
import { ZaloAdapter } from './channels/adapters/zalo.adapter';
import { CredentialService } from './channels/credential.service';
import { PrismaService } from './common/prisma.service';
import { QueueService } from './common/queue.service';
import { SimulatorService } from './demo/simulator.service';
import { StorageService } from './files/storage.service';
import { ConversationOpsService } from './inbox/conversation-ops.service';
import { OutboxProcessor } from './outbox/outbox.processor';
import { OutboxService } from './outbox/outbox.service';
import { SendPolicyService } from './outbox/send-policy.service';
import { RealtimePublisher } from './realtime/realtime.publisher';
import { AutomationService } from './rules/automation.service';
import { WebhookIngestService } from './webhooks/webhook-ingest.service';
import { WebhookProcessorService } from './webhooks/webhook-processor.service';

const providers = [
  PrismaService, QueueService, RealtimePublisher, AuditService, AuthService, AccessService,
  FacebookAdapter, ZaloAdapter, SimulatedAdapter, AdapterRegistry, CredentialService, StorageService,
  SendPolicyService, OutboxService, OutboxProcessor, ConversationOpsService, AutomationService,
  WebhookIngestService, WebhookProcessorService, SimulatorService, KnowledgeService, AiService, MaintenanceService,
];

/** Dịch vụ dùng chung giữa API và worker. Đăng ký bộ xử lý job (chạy khi worker khởi động hoặc ở chế độ inline). */
@Global()
@Module({ providers, exports: providers })
export class CoreModule implements OnModuleInit {
  constructor(
    private webhook: WebhookProcessorService,
    private outbox: OutboxProcessor,
    private ai: AiService,
    private knowledge: KnowledgeService,
    private maintenance: MaintenanceService,
  ) {}

  onModuleInit() {
    this.webhook.register();
    this.outbox.register();
    this.ai.register();
    this.knowledge.register();
    this.maintenance.register();
  }
}
