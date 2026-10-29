import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AiController } from './ai/ai.controller';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/guards';
import { ChannelsController } from './channels/channels.controller';
import { CoreModule } from './core.module';
import { CustomersController } from './customers/customers.controller';
import { DemoController } from './demo/demo.controller';
import { FilesController } from './files/files.controller';
import { HealthController } from './health.controller';
import { ConversationsController } from './inbox/conversations.controller';
import { LibraryController } from './inbox/library.controller';
import { MembersController } from './members/members.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { ReportsController } from './reports/reports.controller';
import { RulesController } from './rules/rules.controller';
import { WebhooksController } from './webhooks/webhooks.controller';

@Module({
  imports: [CoreModule],
  controllers: [
    HealthController, AuthController, WebhooksController, ChannelsController, ConversationsController, LibraryController,
    CustomersController, RulesController, AiController, MembersController, ReportsController, AdminController, FilesController, DemoController,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }, RealtimeGateway],
})
export class AppModule {}
