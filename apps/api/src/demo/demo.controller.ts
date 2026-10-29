import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { Roles, WRITE_ROLES, Ws, WorkspaceCtx } from '../auth/context';
import { AppError } from '../common/errors';
import { parse } from '../common/validation';
import { SimulatorService } from './simulator.service';

const InboundDto = z.object({ channelId: z.string(), userExternalId: z.string().max(64).optional(), customerName: z.string().max(100).optional(), text: z.string().min(1).max(2000) });
const FailDto = z.object({ channelId: z.string(), failure: z.enum(['fail', 'rate_limit', 'timeout', 'auth']) });

/** Công cụ mô phỏng — chỉ hoạt động trong workspace demo. */
@Controller('demo')
export class DemoController {
  constructor(private sim: SimulatorService) {}

  private guard(ws: WorkspaceCtx) {
    if (!ws.isDemo) throw new AppError('NOT_DEMO', 'Công cụ mô phỏng chỉ dùng trong workspace demo', 403);
  }

  @Roles(...WRITE_ROLES)
  @Post('inbound')
  async inbound(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    this.guard(ws);
    return this.sim.simulateInbound(ws.workspaceId, parse(InboundDto, body));
  }

  @Roles(...WRITE_ROLES)
  @Post('fail-next-send')
  async fail(@Ws() ws: WorkspaceCtx, @Body() body: unknown) {
    this.guard(ws);
    const dto = parse(FailDto, body);
    await this.sim.injectFailure(ws.workspaceId, dto.channelId, dto.failure);
    return { ok: true };
  }
}
