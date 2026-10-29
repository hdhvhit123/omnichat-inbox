import { Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';
import { safeEqual } from '../common/crypto';

/** Lưu tệp: S3-compatible (MinIO, R2, S3...) hoặc thư mục cục bộ khi phát triển. */
@Injectable()
export class StorageService {
  private s3: S3Client | null = null;

  private client() {
    if (!this.s3) {
      const c = config();
      this.s3 = new S3Client({
        region: c.S3_REGION,
        endpoint: c.S3_ENDPOINT,
        forcePathStyle: c.S3_FORCE_PATH_STYLE,
        credentials: c.S3_ACCESS_KEY ? { accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY ?? '' } : undefined,
      });
    }
    return this.s3;
  }

  private localPath(key: string) {
    const base = path.resolve(config().STORAGE_LOCAL_DIR);
    const p = path.resolve(base, key);
    if (!p.startsWith(base + path.sep)) throw new Error('Khoá lưu trữ không hợp lệ');
    return p;
  }

  async put(key: string, data: Buffer, mime: string) {
    if (config().STORAGE_DRIVER === 's3') {
      await this.client().send(new PutObjectCommand({ Bucket: config().S3_BUCKET, Key: key, Body: data, ContentType: mime }));
      return;
    }
    const p = this.localPath(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }

  async get(key: string): Promise<Buffer> {
    if (config().STORAGE_DRIVER === 's3') {
      const r = await this.client().send(new GetObjectCommand({ Bucket: config().S3_BUCKET, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    }
    return fs.readFile(this.localPath(key));
  }

  async delete(key: string) {
    if (config().STORAGE_DRIVER === 's3') {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await this.client().send(new DeleteObjectCommand({ Bucket: config().S3_BUCKET, Key: key }));
      return;
    }
    await fs.rm(this.localPath(key), { force: true });
  }

  /** URL tải có thời hạn. S3: presigned URL; local: URL ký HMAC qua API. */
  async signedUrl(key: string, filename: string, ttlSec = 600): Promise<string> {
    if (config().STORAGE_DRIVER === 's3') {
      return getSignedUrl(
        this.client(),
        new GetObjectCommand({ Bucket: config().S3_BUCKET, Key: key, ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }),
        { expiresIn: ttlSec },
      );
    }
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = this.sign(key, exp);
    return `${config().PUBLIC_API_URL}/api/files/raw?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
  }

  sign(key: string, exp: number) {
    return createHmac('sha256', config().ENCRYPTION_KEY).update(`${key}:${exp}`).digest('hex');
  }

  verifySignature(key: string, exp: number, sig: string) {
    return exp > Date.now() / 1000 && safeEqual(this.sign(key, exp), sig);
  }
}

const SIGNATURES: [string, number[]][] = [
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
];

export const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv', 'video/mp4', 'audio/mpeg', 'audio/mp4',
]);

/** Kiểm tra chữ ký tệp (magic bytes) khớp với loại khai báo cho các định dạng phổ biến. */
export function sniffMatches(mime: string, buf: Buffer): boolean {
  const zipBased = mime.includes('openxmlformats');
  const expected = zipBased ? 'application/zip' : mime;
  const sig = SIGNATURES.find(([m]) => m === expected);
  if (!sig) return true; // định dạng không có chữ ký cố định (text, mp4, webp...) — dựa vào allowlist
  return sig[1].every((b, i) => buf[i] === b);
}

export function attachmentKind(mime: string): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}
