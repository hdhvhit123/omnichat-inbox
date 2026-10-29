import { checkGrounding, redactContact } from '../src/ai/ai.service';
import { chunkText } from '../src/ai/knowledge.service';
import { containsKeyword, normalizeVi, normalizeVnPhone } from '../src/common/text';
import { isOutsideBusinessHours, ruleMatches } from '../src/rules/rule-engine';
import { parseZalo } from '../src/webhooks/zalo.parser';
import { verifyFacebookSignature } from '../src/webhooks/signature';
import { createHmac } from 'crypto';

describe('Hàm thuần', () => {
  it('chuẩn hoá tiếng Việt khi so khớp nhưng không đổi nội dung gốc', () => {
    expect(normalizeVi('Đặt HÀNG giúp mình')).toBe('dat hang giup minh');
    expect(containsKeyword(normalizeVi('Cho mình HỎI GIÁ áo'), 'hỏi giá')).toBe(true);
    expect(containsKeyword(normalizeVi('chào'), 'hi')).toBe(false);
  });

  it('số điện thoại Việt Nam', () => {
    expect(normalizeVnPhone('+84 901 234 567')).toBe('0901234567');
    expect(normalizeVnPhone('12345')).toBeNull();
  });

  it('quy tắc theo kênh, từ khoá, ý định', () => {
    const rule = { trigger: 'INBOUND_MESSAGE' as const, channelTypes: ['ZALO' as const], channelIds: [], conditions: { intents: ['price'] } };
    expect(ruleMatches(rule, { text: 'Bao nhiêu tiền vậy?', channelType: 'ZALO', channelId: 'c', isNewConversation: false, outsideHours: false }).matched).toBe(true);
    expect(ruleMatches(rule, { text: 'Bao nhiêu tiền vậy?', channelType: 'FACEBOOK', channelId: 'c', isNewConversation: false, outsideHours: false }).matched).toBe(false);
  });

  it('giờ làm việc theo múi giờ Asia/Ho_Chi_Minh', () => {
    const hours = { thu: [['08:00', '17:00']] };
    // 2026-10-29 là thứ Năm; 02:00 UTC = 09:00 giờ VN
    expect(isOutsideBusinessHours(hours, 'Asia/Ho_Chi_Minh', new Date('2026-10-29T02:00:00Z'))).toBe(false);
    expect(isOutsideBusinessHours(hours, 'Asia/Ho_Chi_Minh', new Date('2026-10-29T12:00:00Z'))).toBe(true);
  });

  it('kiểm tra căn cứ AI chặn số liệu/link không có trong nguồn', () => {
    const sources = [{ id: 'S1', chunkId: 'c', documentId: 'd', title: 'FAQ', version: 1, content: 'Phí giao 25.000đ' }];
    expect(checkGrounding({ action: 'reply', reply: 'Phí giao 25.000đ ạ', used_source_ids: ['S1'], reason: '' }, sources).ok).toBe(true);
    expect(checkGrounding({ action: 'reply', reply: 'Phí giao 30.000đ, xem https://x.y', used_source_ids: ['S1'], reason: '' }, sources).ok).toBe(false);
    expect(checkGrounding({ action: 'reply', reply: 'Dạ có ạ', used_source_ids: [], reason: '' }, sources).ok).toBe(false);
  });

  it('chia đoạn FAQ theo cặp hỏi/đáp', () => {
    expect(chunkText('Q: a?\nA: b\n\nQ: c?\nA: d', 'FAQ')).toHaveLength(2);
  });

  it('chữ ký Facebook trên đúng byte nhận được', () => {
    const raw = Buffer.from('{"a":"\\u00e4"}');
    const sig = 'sha256=' + createHmac('sha256', 's').update(raw).digest('hex');
    expect(verifyFacebookSignature(raw, sig, 's')).toBe(true);
    expect(verifyFacebookSignature(raw, sig, 'other')).toBe(false);
  });

  it('phân tích sự kiện Zalo: tin khách, echo OA, đã đọc', () => {
    expect(parseZalo({ event_name: 'user_send_text', timestamp: '1', sender: { id: 'u' }, recipient: { id: 'oa' }, message: { msg_id: 'm', text: 't' } })[0]).toMatchObject({ type: 'message', direction: 'inbound', userExternalId: 'u' });
    expect(parseZalo({ event_name: 'oa_send_text', timestamp: '1', sender: { id: 'oa' }, recipient: { id: 'u' }, message: { msg_id: 'm2', text: 't' } })[0]).toMatchObject({ direction: 'echo', userExternalId: 'u' });
    expect(parseZalo({ event_name: 'user_seen_message', timestamp: '1', sender: { id: 'oa' }, recipient: { id: 'u' }, message: { msg_ids: ['m2'] } })[0]).toMatchObject({ type: 'read', mids: ['m2'] });
  });
  it('che SĐT và email trước khi gửi sang nhà cung cấp AI', () => {
    expect(redactContact('Gọi em 0912 345 678 hoặc +84 912345678, mail a.b@shop.vn nhé')).toBe('Gọi em [sđt] hoặc [sđt], mail [email] nhé');
    expect(redactContact('Áo size 42 giá 250.000đ')).toBe('Áo size 42 giá 250.000đ');
  });
});
