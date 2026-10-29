import { createHash, createHmac } from 'crypto';
import { safeEqual } from '../common/crypto';

/** Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, App Secret) */
export function verifyFacebookSignature(raw: Buffer | undefined, header: string | undefined, appSecret: string | undefined): boolean {
  if (!raw || !header || !appSecret) return false;
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
  return safeEqual(header.trim(), expected);
}

/**
 * Zalo: X-ZEvent-Signature = "mac=" + SHA256(app_id + raw body + timestamp + OA Secret Key)
 * (công thức theo nguồn phụ — xem docs/PLATFORM_SOURCES.md)
 */
export function verifyZaloSignature(raw: Buffer | undefined, header: string | undefined, oaSecretKey: string | undefined): boolean {
  if (!raw || !header || !oaSecretKey) return false;
  let body: any;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return false;
  }
  const mac = createHash('sha256').update(`${body.app_id ?? ''}${raw.toString('utf8')}${body.timestamp ?? ''}${oaSecretKey}`).digest('hex');
  const value = header.trim().replace(/^mac=/, '');
  return safeEqual(value, mac);
}
