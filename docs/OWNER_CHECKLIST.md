# Việc chủ sở hữu cần chuẩn bị

Hệ thống đã chạy được ở chế độ mô phỏng. Để nhận và trả lời tin nhắn thật, cần các mục sau. Đánh dấu khi hoàn thành.

## Hạ tầng
- [ ] Máy chủ Linux (khuyến nghị ≥ 2 vCPU, 4GB RAM, 40GB đĩa) cài Docker + Docker Compose.
- [ ] **Tên miền** (ví dụ `inbox.congty.vn`) có bản ghi A trỏ về máy chủ; mở cổng 80 và 443.
- [ ] Điền `deploy/.env` (từ `.env.example`): mật khẩu Postgres, MinIO, `ENCRYPTION_KEY` (`openssl rand -base64 32`) — **lưu bản sao an toàn**, mất khoá này là mất toàn bộ token đã lưu.
- [ ] `docker compose up -d --build`, rồi tạo chủ sở hữu:
  `docker compose exec -e SEED_DEMO=false -e SEED_OWNER_EMAIL=ban@congty.vn -e SEED_OWNER_PASSWORD='<mật khẩu ≥10 ký tự>' api npx ts-node --transpile-only prisma/seed.ts`
- [ ] Sao lưu định kỳ volume `pgdata` và `miniodata`.

## Meta (Facebook) — chi tiết trong `META_SETUP.md`
- [ ] Meta Business Portfolio đã xác minh doanh nghiệp.
- [ ] Ứng dụng Meta loại Business; App ID, App Secret, Verify Token điền vào `.env`.
- [ ] Redirect URI và Webhook URL khai báo đúng tên miền.
- [ ] Trang Chính sách quyền riêng tư + hướng dẫn xoá dữ liệu công khai.
- [ ] **App Review**: Advanced Access cho `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`; chuyển ứng dụng sang Live.
- [ ] (Tuỳ chọn) Duyệt tính năng Human Agent trước khi bật trong Cài đặt.
- [ ] Tài khoản quản trị Fanpage kết nối Page trong hệ thống; nhắn thử và trả lời thử thành công.

## Zalo — chi tiết trong `ZALO_SETUP.md`
- [ ] OA đã xác thực, gói dịch vụ cho phép gửi tin tư vấn qua API.
- [ ] Ứng dụng Zalo for Developers liên kết OA; App ID, App Secret, OA Secret Key điền vào `.env`.
- [ ] Callback URL và Webhook URL khai báo đúng tên miền; bật các sự kiện tin nhắn.
- [ ] Đối chiếu mục “Cần xác minh” (chữ ký webhook, endpoint gửi tin, cửa sổ 48 giờ, mã lỗi).
- [ ] Kết nối OA trong hệ thống; nhắn thử (tài khoản đã quan tâm OA) và trả lời thử thành công.

## AI (tuỳ chọn)
- [ ] API key nhà cung cấp (ví dụ Anthropic) nhập ở *Chatbot & kho kiến thức* (lưu mã hoá).
- [ ] Nhập đơn giá theo bảng giá nhà cung cấp; đặt ngân sách ngày/tháng.
- [ ] Đưa FAQ/tài liệu chính sách, giá, giao hàng vào kho kiến thức và **duyệt**.
- [ ] Bắt đầu ở chế độ **Trợ lý**; chỉ chuyển **Tự động** sau khi kiểm tra chất lượng nháp.

## Vận hành
- [ ] Thêm nhân viên, gán vai trò và kênh.
- [ ] Cấu hình giờ làm việc, thời hạn lưu trữ, câu trả lời mẫu, quy tắc chào/ngoài giờ (bật khỏi chế độ thử khi đã kiểm tra bằng công cụ “Thử quy tắc”).
- [ ] Đặt `DEMO_MODE=false` ở môi trường thật (workspace demo vẫn tách biệt nếu đã tạo, nhưng không cần thiết).
