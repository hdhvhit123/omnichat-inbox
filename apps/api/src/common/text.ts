/**
 * Chuẩn hoá tiếng Việt để so khớp: chữ thường, bỏ dấu, đ→d, gộp khoảng trắng.
 * Chỉ dùng để so khớp/tìm kiếm; nội dung gốc luôn được giữ nguyên.
 */
export function normalizeVi(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.+\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** So khớp từ khoá theo ranh giới từ trên văn bản đã chuẩn hoá. */
export function containsKeyword(normalizedText: string, keyword: string): boolean {
  const k = normalizeVi(keyword);
  if (!k) return false;
  return ` ${normalizedText} `.includes(` ${k} `);
}

export function preview(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Số điện thoại Việt Nam (di động/cố định), chấp nhận +84 / 84 / 0. */
export function normalizeVnPhone(input: string): string | null {
  const digits = input.replace(/[\s.\-()]/g, '');
  const m = digits.match(/^(?:\+?84|0)(\d{9,10})$/);
  return m ? `0${m[1]}` : null;
}
