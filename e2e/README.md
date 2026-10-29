# Kiểm thử giao diện (smoke, trình duyệt thật)

Chạy với dữ liệu demo đã seed (`pnpm db:seed`), API + worker + web đang chạy:

```bash
cd e2e
BASE_URL=http://localhost:3000 node smoke-inbox.js    # đăng nhập, tin mô phỏng, trả lời, trạng thái Đã xem, ghi chú, chụp 10 trang
BASE_URL=http://localhost:3000 node smoke-failure.js  # giả lập timeout → "Chưa xác định", gửi lại yêu cầu xác nhận trùng
```
Cần gói `playwright` và Chromium. Ảnh chụp lưu trong `e2e/screenshots/` (không commit).
