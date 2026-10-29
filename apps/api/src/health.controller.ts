import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/context';
import { config } from './config';
import { PrismaService } from './common/prisma.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    const c = config();
    return {
      ok: true,
      time: new Date().toISOString(),
      integrations: {
        meta: { configured: !!(c.META_APP_ID && c.META_APP_SECRET && c.META_VERIFY_TOKEN), graphVersion: c.META_GRAPH_VERSION },
        zalo: { configured: !!(c.ZALO_APP_ID && c.ZALO_APP_SECRET && c.ZALO_OA_SECRET_KEY) },
      },
      demoMode: c.DEMO_MODE,
    };
  }
}
