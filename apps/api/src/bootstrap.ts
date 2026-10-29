import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import cookieParser from 'cookie-parser';
import type { ServerOptions } from 'socket.io';
import { config } from './config';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { newRedisConnection } from './common/redis';

class RedisIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (config().QUEUE_MODE !== 'inline') server.adapter(createAdapter(newRedisConnection(), newRedisConnection()));
    return server;
  }
}

/** Cấu hình dùng chung cho main.ts và kiểm thử e2e. */
export function configureApp(app: INestApplication) {
  const c = config();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: c.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new RedisIoAdapter(app));
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 1);
  http.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
}
