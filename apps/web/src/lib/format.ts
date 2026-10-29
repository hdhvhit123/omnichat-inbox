export const TZ = 'Asia/Ho_Chi_Minh';

const dtf = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const tf = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const df = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Thời gian luôn lưu UTC ở máy chủ, hiển thị theo giờ Việt Nam. */
export function fmtDateTime(v?: string | Date | null) {
  return v ? dtf.format(new Date(v)) : '—';
}
export function fmtTime(v?: string | Date | null) {
  return v ? tf.format(new Date(v)) : '';
}
export function fmtDate(v?: string | Date | null) {
  return v ? df.format(new Date(v)) : '—';
}
export function vnDayKey(v: string | Date) {
  return dayKey.format(new Date(v));
}

/** Thời gian ngắn cho danh sách: hôm nay → giờ; khác → ngày. */
export function fmtShort(v?: string | Date | null) {
  if (!v) return '';
  return vnDayKey(v) === vnDayKey(new Date()) ? fmtTime(v) : df.format(new Date(v)).slice(0, 5);
}

export function fmtRelative(v?: string | Date | null) {
  if (!v) return 'chưa có';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

export function fmtDuration(sec?: number | null) {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)} giây`;
  if (sec < 3600) return `${Math.round(sec / 60)} phút`;
  return `${(sec / 3600).toFixed(1)} giờ`;
}

export function fmtRemaining(v?: string | null) {
  if (!v) return '';
  const ms = new Date(v).getTime() - Date.now();
  if (ms <= 0) return 'đã hết hạn';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `còn ${h} giờ ${m} phút` : `còn ${m} phút`;
}

export function fmtUsd(v?: number | null) {
  return `$${(v ?? 0).toFixed(4)}`;
}
export function fmtPct(v?: number | null) {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
