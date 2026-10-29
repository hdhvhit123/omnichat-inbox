export const ROLE_LABEL: Record<string, string> = { OWNER: 'Chủ sở hữu', MANAGER: 'Quản lý', AGENT: 'Nhân viên', VIEWER: 'Người xem' };
export const CONV_STATUS: Record<string, { label: string; cls: string }> = {
  NEW: { label: 'Mới', cls: 'bg-blue-100 text-blue-800' },
  OPEN: { label: 'Đang xử lý', cls: 'bg-amber-100 text-amber-800' },
  PENDING: { label: 'Chờ khách', cls: 'bg-purple-100 text-purple-800' },
  RESOLVED: { label: 'Đã giải quyết', cls: 'bg-green-100 text-green-800' },
};
export const CHANNEL_LABEL: Record<string, string> = { FACEBOOK: 'Facebook', ZALO: 'Zalo OA' };
export const CHANNEL_STATUS: Record<string, { label: string; cls: string }> = {
  CONNECTED: { label: 'Đã kết nối', cls: 'bg-green-100 text-green-800' },
  PENDING: { label: 'Chờ xác minh', cls: 'bg-amber-100 text-amber-800' },
  ERROR: { label: 'Lỗi', cls: 'bg-red-100 text-red-800' },
  DISCONNECTED: { label: 'Đã ngắt', cls: 'bg-gray-200 text-gray-700' },
};
export const MSG_STATUS: Record<string, { label: string; cls: string; hint: string }> = {
  RECEIVED: { label: 'Đã nhận', cls: 'text-gray-500', hint: '' },
  PENDING: { label: 'Đang gửi', cls: 'text-gray-500', hint: 'Đang chờ gửi tới nền tảng' },
  ACCEPTED: { label: 'Nền tảng đã nhận', cls: 'text-gray-600', hint: 'API nền tảng đã chấp nhận tin. Chưa có xác nhận đã chuyển tới khách.' },
  DELIVERED: { label: 'Đã chuyển', cls: 'text-blue-600', hint: 'Nền tảng báo đã chuyển tới thiết bị khách' },
  READ: { label: 'Đã xem', cls: 'text-green-600', hint: 'Nền tảng báo khách đã xem' },
  FAILED: { label: 'Thất bại', cls: 'text-red-600', hint: 'Gửi không thành công' },
  UNKNOWN: { label: 'Chưa xác định', cls: 'text-orange-600', hint: 'Không nhận được phản hồi từ nền tảng (hết thời gian chờ). Tin có thể đã hoặc chưa tới khách.' },
  BLOCKED: { label: 'Bị chặn', cls: 'text-red-600', hint: 'Không đủ điều kiện gửi theo chính sách' },
  CANCELLED: { label: 'Đã huỷ', cls: 'text-gray-500', hint: 'Đã huỷ trước khi gửi' },
};
export const BOT_MODE: Record<string, string> = { MANUAL: 'Thủ công', ASSIST: 'Trợ lý (soạn nháp)', AUTO: 'Tự động' };
export const SENDER_LABEL: Record<string, string> = { CUSTOMER: 'Khách', AGENT: 'Nhân viên', BOT: 'Chatbot AI', RULE: 'Quy tắc tự động', SYSTEM: 'Hệ thống' };
export const AI_STATUS: Record<string, string> = {
  QUEUED: 'Đang chờ', RUNNING: 'Đang xử lý', DRAFTED: 'Bản nháp chờ duyệt', SENT: 'Đã gửi', HANDOFF: 'Chuyển nhân viên', CANCELLED: 'Đã huỷ', FAILED: 'Lỗi', BLOCKED: 'Bị chặn gửi',
};
export const DOC_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'Chờ xử lý', cls: 'bg-gray-100 text-gray-700' },
  PROCESSING: { label: 'Đang xử lý', cls: 'bg-amber-100 text-amber-800' },
  READY: { label: 'Sẵn sàng', cls: 'bg-green-100 text-green-800' },
  FAILED: { label: 'Lỗi', cls: 'bg-red-100 text-red-800' },
  ARCHIVED: { label: 'Lưu trữ', cls: 'bg-gray-100 text-gray-500' },
};
export const TRIGGER_LABEL: Record<string, string> = { NEW_CONVERSATION: 'Hội thoại mới', INBOUND_MESSAGE: 'Mỗi tin nhắn của khách', OUTSIDE_HOURS: 'Ngoài giờ làm việc' };
export const ACTION_LABEL: Record<string, string> = { SEND_TEXT: 'Gửi tin', ADD_TAG: 'Gắn nhãn', ASSIGN: 'Phân công', HANDOFF: 'Chuyển nhân viên', START_LEAD_CAPTURE: 'Thu thập thông tin (tên → SĐT → nhu cầu)', SET_STATUS: 'Đổi trạng thái' };
export const SEND_FAIL_LABEL: Record<string, string> = { fail: 'Lỗi gửi', rate_limit: 'Vượt giới hạn tốc độ', timeout: 'Hết thời gian chờ (không rõ kết quả)', auth: 'Token hết hạn' };
