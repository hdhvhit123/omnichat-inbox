import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Khoá 32 byte (base64) dùng mã hoá token/bí mật khi lưu
  ENCRYPTION_KEY: z.string().min(40),
  APP_URL: z.string().default('http://localhost:3000'),
  // Địa chỉ public HTTPS của API (dùng cho redirect OAuth và webhook)
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_SECURE: bool,
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 7),
  // inline: chạy job ngay trong tiến trình (chỉ cho kiểm thử)
  QUEUE_MODE: z.enum(['bullmq', 'inline']).default('bullmq'),
  // Cho phép tạo workspace demo với kênh mô phỏng
  DEMO_MODE: bool,

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v26.0'),
  META_GRAPH_BASE: z.string().default('https://graph.facebook.com'),
  META_OAUTH_DIALOG: z.string().default('https://www.facebook.com'),

  ZALO_APP_ID: z.string().optional(),
  ZALO_APP_SECRET: z.string().optional(),
  // "OA Secret Key" trong phần cấu hình webhook của ứng dụng Zalo — dùng kiểm tra chữ ký
  ZALO_OA_SECRET_KEY: z.string().optional(),
  ZALO_OAUTH_BASE: z.string().default('https://oauth.zaloapp.com'),
  ZALO_OPENAPI_BASE: z.string().default('https://openapi.zalo.me'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('omnichat'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  MAX_UPLOAD_MB: z.coerce.number().default(25),

  PLATFORM_HTTP_TIMEOUT_MS: z.coerce.number().default(15000),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;
export function config(): AppConfig {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Cấu hình môi trường không hợp lệ: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Chỉ dùng trong kiểm thử để nạp lại biến môi trường. */
export function resetConfig() {
  cached = null;
}
