import { Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { config } from '../config';
import { safeEqual } from '../common/crypto';
import { Public } from '../auth/context';
import { parseFacebook } from './facebook.parser';
import { parseZalo } from './zalo.parser';
import { verifyFacebookSignature, verifyZaloSignature } from './signature';
import { WebhookIngestService } from './webhook-ingest.service';

@Public()
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger('Webhooks');
  constructor(private ingest: WebhookIngestService) {}

  /** Meta gọi GET để xác minh URL webhook */
  @Get('facebook')
  verifyFacebook(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    const expected = config().META_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token && safeEqual(token, expected)) return res.status(200).send(challenge);
    return res.sendStatus(403);
  }

  @Post('facebook')
  @HttpCode(200)
  async facebook(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    if (!verifyFacebookSignature(req.rawBody, req.header('x-hub-signature-256'), config().META_APP_SECRET)) {
      this.log.warn('Từ chối webhook Facebook: chữ ký không hợp lệ');
      return res.status(401).json({ code: 'INVALID_SIGNATURE' });
    }
    const result = await this.ingest.ingest(parseFacebook(req.body));
    return res.status(200).json({ ok: true, ...result });
  }

  @Post('zalo')
  @HttpCode(200)
  async zalo(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    if (!verifyZaloSignature(req.rawBody, req.header('x-zevent-signature'), config().ZALO_OA_SECRET_KEY)) {
      this.log.warn('Từ chối webhook Zalo: chữ ký không hợp lệ');
      return res.status(401).json({ code: 'INVALID_SIGNATURE' });
    }
    if (config().ZALO_APP_ID && req.body?.app_id && String(req.body.app_id) !== config().ZALO_APP_ID) {
      return res.status(401).json({ code: 'APP_MISMATCH' });
    }
    const result = await this.ingest.ingest(parseZalo(req.body));
    return res.status(200).json({ ok: true, ...result });
  }
}
