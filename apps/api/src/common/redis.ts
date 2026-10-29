import IORedis from 'ioredis';
import { config } from '../config';

let client: IORedis | null = null;

export function redis(): IORedis {
  if (!client) {
    client = new IORedis(config().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return client;
}

export function newRedisConnection(): IORedis {
  return new IORedis(config().REDIS_URL, { maxRetriesPerRequest: null });
}

export async function closeRedis() {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}

/** Khoá phân tán đơn giản (SET NX PX) có token chủ sở hữu. */
export async function withRedisLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const token = Math.random().toString(36).slice(2);
  const ok = await redis().set(key, token, 'PX', ttlMs, 'NX');
  if (!ok) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    // Chỉ xoá nếu vẫn là chủ khoá
    await redis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }
}
