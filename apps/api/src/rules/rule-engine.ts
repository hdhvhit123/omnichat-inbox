import { AutomationRule, ChannelType } from '@prisma/client';
import { containsKeyword, normalizeVi } from '../common/text';

/** Ý định dựng sẵn: tập từ khoá (đã chuẩn hoá không dấu). */
export const BUILTIN_INTENTS: Record<string, { label: string; keywords: string[] }> = {
  price: { label: 'Hỏi giá', keywords: ['gia', 'bao nhieu', 'bao nhieu tien', 'bang gia', 'gia ca', 'chi phi', 'phi'] },
  address: { label: 'Hỏi địa chỉ', keywords: ['dia chi', 'o dau', 'cho nao', 'chi duong', 'ban do'] },
  hours: { label: 'Hỏi giờ mở cửa', keywords: ['gio mo cua', 'may gio', 'gio lam viec', 'mo cua', 'dong cua'] },
  human: { label: 'Muốn gặp người thật', keywords: ['nguoi that', 'nhan vien', 'tu van vien', 'gap nguoi', 'admin', 'goi lai', 'noi chuyen voi nguoi'] },
  complaint: { label: 'Khiếu nại', keywords: ['khieu nai', 'buc minh', 'lua dao', 'hoan tien', 'tra hang', 'that vong', 'te qua', 'boc phot', 'kien'] },
  greeting: { label: 'Chào hỏi', keywords: ['xin chao', 'chao', 'hello', 'hi', 'alo'] },
};

export interface RuleConditions {
  keywords?: string[];
  match?: 'any' | 'all';
  excludeKeywords?: string[];
  intents?: string[];
}

export interface RuleAction {
  type: 'SEND_TEXT' | 'ADD_TAG' | 'ASSIGN' | 'HANDOFF' | 'START_LEAD_CAPTURE' | 'SET_STATUS';
  text?: string;
  tagName?: string;
  userId?: string;
  reason?: string;
  status?: 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED';
}

export interface MatchContext {
  text: string | null;
  channelType: ChannelType;
  channelId: string;
  isNewConversation: boolean;
  outsideHours: boolean;
}

/** Hàm thuần: quy tắc có khớp tin đến không (không xét cooldown/giới hạn — phần đó cần DB). */
export function ruleMatches(rule: Pick<AutomationRule, 'trigger' | 'channelTypes' | 'channelIds' | 'conditions'>, ctx: MatchContext): { matched: boolean; why: string } {
  if (rule.channelTypes.length && !rule.channelTypes.includes(ctx.channelType)) return { matched: false, why: 'Không áp dụng cho loại kênh này' };
  if (rule.channelIds.length && !rule.channelIds.includes(ctx.channelId)) return { matched: false, why: 'Không áp dụng cho tài khoản này' };
  if (rule.trigger === 'NEW_CONVERSATION' && !ctx.isNewConversation) return { matched: false, why: 'Không phải hội thoại mới' };
  if (rule.trigger === 'OUTSIDE_HOURS' && !ctx.outsideHours) return { matched: false, why: 'Đang trong giờ làm việc' };
  const cond = (rule.conditions ?? {}) as RuleConditions;
  const norm = normalizeVi(ctx.text);
  if (cond.excludeKeywords?.some((k) => containsKeyword(norm, k))) return { matched: false, why: 'Chứa từ khoá loại trừ' };
  const kws = cond.keywords?.filter(Boolean) ?? [];
  const intents = cond.intents?.filter((i) => BUILTIN_INTENTS[i]) ?? [];
  if (!kws.length && !intents.length) return { matched: true, why: 'Không có điều kiện từ khoá' };
  const kwHits = kws.map((k) => containsKeyword(norm, k));
  const kwOk = kws.length ? (cond.match === 'all' ? kwHits.every(Boolean) : kwHits.some(Boolean)) : false;
  const intentOk = intents.some((i) => BUILTIN_INTENTS[i].keywords.some((k) => containsKeyword(norm, k)));
  if (kwOk || intentOk) return { matched: true, why: kwOk ? 'Khớp từ khoá' : 'Khớp ý định' };
  return { matched: false, why: 'Không khớp từ khoá/ý định' };
}

export function hasReplyAction(actions: RuleAction[]) {
  return actions.some((a) => a.type === 'SEND_TEXT' || a.type === 'START_LEAD_CAPTURE');
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** businessHours: {"mon":[["08:00","17:30"]], ...} theo múi giờ workspace. null = luôn trong giờ. */
export function isOutsideBusinessHours(businessHours: unknown, timezone: string, at = new Date()): boolean {
  if (!businessHours || typeof businessHours !== 'object') return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const wd = parts.find((p) => p.type === 'weekday')!.value.toLowerCase().slice(0, 3);
  const hh = parts.find((p) => p.type === 'hour')!.value.replace('24', '00');
  const mm = parts.find((p) => p.type === 'minute')!.value;
  const now = `${hh}:${mm}`;
  const ranges: [string, string][] = (businessHours as Record<string, [string, string][]>)[DAYS.includes(wd) ? wd : 'mon'] ?? [];
  return !ranges.some(([from, to]) => now >= from && now < to);
}
