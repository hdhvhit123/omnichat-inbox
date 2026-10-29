import { ChannelType } from '@prisma/client';

export interface NormalizedAttachment {
  type: string; // image | video | audio | file | sticker | location | link ...
  url?: string;
  name?: string;
}

interface Base {
  provider: ChannelType;
  /** Page ID / OA ID có thể là kênh; chọn cái khớp kênh đã kết nối */
  channelCandidates: string[];
  eventKey: string;
  timestamp: Date;
  raw: unknown;
}

export type NormalizedEvent =
  | (Base & {
      type: 'message';
      direction: 'inbound' | 'echo';
      userExternalId: string;
      externalMessageId: string;
      text?: string;
      attachments?: NormalizedAttachment[];
      metadata?: string;
      appId?: string;
      isPostback?: boolean;
      /** Tên hiển thị nếu nền tảng/simulator cung cấp kèm sự kiện */
      profileName?: string;
    })
  | (Base & { type: 'delivery' | 'read'; userExternalId: string; mids?: string[]; watermark?: number })
  | (Base & { type: 'follow' | 'unfollow'; userExternalId: string })
  | (Base & { type: 'ignored'; reason: string });

export type EventType = NormalizedEvent['type'];
