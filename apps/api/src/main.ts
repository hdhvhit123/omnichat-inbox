import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { config } from './config';

async function bootstrap() {
  const c = config();
  // rawBody: cần để kiểm tra chữ ký webhook trên đúng byte nhận được
  const app = await NestFactory.create(AppModule, { rawBody: true, bodyParser: true });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(c.PORT, '0.0.0.0');
  Logger.log(`API chạy tại cổng ${c.PORT}`, 'Bootstrap');
}
bootstrap();
