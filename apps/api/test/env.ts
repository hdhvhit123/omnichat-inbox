// Biến môi trường cho kiểm thử: DB riêng, hàng đợi inline, khoá giả.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://omni:omni@localhost:5432/omnichat_test';
process.env.QUEUE_MODE = 'inline';
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.META_APP_ID = 'test-app';
process.env.META_APP_SECRET = 'test-meta-secret';
process.env.META_VERIFY_TOKEN = 'verify-me';
process.env.ZALO_APP_ID = 'zalo-app';
process.env.ZALO_APP_SECRET = 'zalo-secret';
process.env.ZALO_OA_SECRET_KEY = 'zalo-oa-secret';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.PLATFORM_HTTP_TIMEOUT_MS = '400';
process.env.STORAGE_LOCAL_DIR = '/tmp/omnichat-test-storage';
// Mặc định trỏ tới cổng không tồn tại; từng test bật máy chủ giả và ghi đè
process.env.META_GRAPH_BASE = 'http://127.0.0.1:9';
process.env.ZALO_OPENAPI_BASE = 'http://127.0.0.1:9';
process.env.ZALO_OAUTH_BASE = 'http://127.0.0.1:9';
