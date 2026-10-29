import { Channel } from '@prisma/client';

export interface OutgoingAttachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url: string; // URL có thời hạn để nền tảng tải về
  name: string;
  mime: string;
  size: number;
  data?: () => Promise<Buffer>; // dùng khi nền tảng yêu cầu upload trước (Zalo file)
}

export interface OutgoingMessage {
  outboundId: string;
  recipientId: string;
  text?: string | null;
  attachment?: OutgoingAttachment | null;
  /** Do SendPolicyService quyết định, adapter không tự đổi. */
  sendParams: { messagingType?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG'; tag?: string; zaloType?: 'cs' };
}

export type SendOutcome =
  | { outcome: 'accepted'; externalId?: string; raw?: unknown }
  | {
      outcome: 'failed';
      retryable: boolean;
      code: string;
      message: string;
      retryAfterMs?: number;
      /** token/quyền không hợp lệ → cập nhật trạng thái kênh */
      authError?: boolean;
      /** người nhận không thể nhận tin (bỏ quan tâm, chặn...) */
      recipientUnavailable?: boolean;
    }
  | { outcome: 'unknown'; message: string };

export type VerifyOutcome =
  | { ok: true; externalId: string; name: string; avatarUrl?: string; detail?: string }
  | { ok: false; code: string; message: string; authError?: boolean };

export interface ChannelAdapter {
  readonly kind: 'facebook' | 'zalo' | 'simulated';
  send(channel: Channel, accessToken: string, msg: OutgoingMessage): Promise<SendOutcome>;
  verify(channel: Channel, accessToken: string): Promise<VerifyOutcome>;
}

/** Khả năng gửi thực tế từng kênh (dùng cho kiểm tra điều kiện và giao diện). */
export const CHANNEL_CAPABILITIES = {
  FACEBOOK: { text: true, maxTextLength: 2000, attachments: ['image', 'file', 'audio', 'video'], maxAttachmentMb: 25 },
  ZALO: { text: true, maxTextLength: 2000, attachments: ['image', 'file'], maxAttachmentMb: 5, imageMaxMb: 1, imageMimes: ['image/jpeg', 'image/png'] },
} as const;
