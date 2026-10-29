# Hướng dẫn kết nối Facebook Fanpage (Meta)

Tài liệu đối chiếu ngày 29/10/2026 — xem `PLATFORM_SOURCES.md`. Giao diện Meta App Dashboard có thể đổi tên mục; nếu khác, tìm theo tên quyền/tính năng.

## 0. Cần chuẩn bị (chủ sở hữu)
- Tài khoản Facebook là **quản trị viên** (hoặc có quyền nhắn tin) của các Fanpage cần kết nối.
- **Meta Business Portfolio** (Business Manager) đã xác minh doanh nghiệp — cần cho App Review quyền nâng cao.
- Tên miền HTTPS công khai trỏ về máy chủ (ví dụ `inbox.congty.vn`), đã chạy `deploy/docker-compose.yml`.
- Trang Chính sách quyền riêng tư công khai (URL) và hướng dẫn xoá dữ liệu — bắt buộc khi gửi App Review.

## 1. Tạo ứng dụng Meta
1. Vào https://developers.facebook.com/apps → **Tạo ứng dụng** → loại **Business**.
2. Gắn ứng dụng với Business Portfolio của doanh nghiệp.
3. Thêm sản phẩm **Messenger** và **Facebook Login for Business** (hoặc Facebook Login).
4. *App settings → Basic*: ghi lại **App ID**, **App Secret**; điền Privacy Policy URL, App Domain (`inbox.congty.vn`), biểu tượng, danh mục.

## 2. Cấu hình máy chủ
Trong `deploy/.env`:
```
META_APP_ID=<App ID>
META_APP_SECRET=<App Secret>
META_VERIFY_TOKEN=<chuỗi ngẫu nhiên tự đặt, ví dụ: openssl rand -hex 16>
META_GRAPH_VERSION=v26.0
```
Khởi động lại: `docker compose up -d api worker`.

## 3. Facebook Login: redirect URI
*Facebook Login → Settings → Valid OAuth Redirect URIs*:
```
https://inbox.congty.vn/api/oauth/facebook/callback
```

## 4. Webhook
*Messenger → Settings → Webhooks* (hoặc *Webhooks* → đối tượng **Page**):
- Callback URL: `https://inbox.congty.vn/api/webhooks/facebook`
- Verify token: đúng giá trị `META_VERIFY_TOKEN`
- Đăng ký các trường: `messages`, `message_echoes`, `message_deliveries`, `message_reads`, `messaging_postbacks`

Hệ thống tự gọi `POST /{page-id}/subscribed_apps` cho từng Page khi bạn kết nối, và nút **Kiểm tra kết nối** báo Page đã đăng ký webhook hay chưa.

## 5. Kết nối Page trong hệ thống
1. Đăng nhập bằng tài khoản **Chủ sở hữu**, chọn workspace thật (không phải demo).
2. *Kết nối kênh* → **Kết nối Facebook Page** → đăng nhập Facebook, chọn các Page, cấp quyền.
3. Quay lại hệ thống, chọn Page cần kết nối → hệ thống lưu Page token (mã hoá), đăng ký webhook, gọi API xác minh.
4. Page chỉ hiển thị **Đã kết nối** khi xác minh API thành công.
5. Kiểm tra đầu-cuối: dùng một tài khoản Facebook có vai trò trong ứng dụng (Admin/Developer/Tester) nhắn tin cho Page → tin xuất hiện trong Hộp thư → trả lời → tin tới Messenger. **Chỉ coi là tích hợp thành công sau bước này.**

Cách thay thế: *Nhập token thủ công* bằng Page Access Token tạo trong Meta Business Suite / Graph API Explorer (vẫn phải đăng ký webhook).

## 6. Quyền & App Review
Ở chế độ **Development**, ứng dụng chỉ nhận/gửi tin với người có vai trò trong ứng dụng. Để phục vụ khách thật cần **Live mode** và **Advanced Access** cho:

| Quyền | Dùng để |
|---|---|
| `pages_messaging` | Nhận và trả lời tin nhắn của Page |
| `pages_manage_metadata` | Đăng ký webhook cho Page (phụ thuộc của `pages_messaging`) |
| `pages_show_list` | Liệt kê Page để chọn (phụ thuộc của `pages_messaging`) |
| `pages_read_engagement` | Đọc tên/ảnh Page |

Tuỳ chọn: tính năng **Human Agent** (tag `HUMAN_AGENT`, nhân viên trả lời trong 7 ngày). Chỉ bật trong *Cài đặt → Facebook HUMAN_AGENT* **sau khi** Meta duyệt.

Gợi ý hồ sơ App Review:
- Video quay màn hình: đăng nhập → kết nối Page → khách nhắn tin → nhân viên trả lời trong Hộp thư → tin hiện trên Messenger.
- Mô tả: “Hộp thư chăm sóc khách hàng cho doanh nghiệp; nhân viên trả lời tin nhắn khách gửi tới Page; chatbot chỉ trả lời trong 24 giờ dựa trên tài liệu do doanh nghiệp duyệt; không gửi tin quảng cáo.”
- Tài khoản kiểm thử cho người duyệt (tạo bằng *Nhân viên & phân quyền*).

## 7. Hạn chế đã áp dụng trong hệ thống
- Tin thường chỉ gửi trong 24 giờ kể từ tin gần nhất của khách (`messaging_type=RESPONSE`).
- Không tự gắn tag để gửi ngoài 24 giờ. `HUMAN_AGENT` chỉ dùng khi chủ sở hữu bật và chỉ cho nhân viên.
- Không lấy được lịch sử tin trước khi kết nối.
- Đã chuyển/đã xem chỉ hiển thị khi Meta gửi sự kiện tương ứng.

## Xử lý sự cố
| Hiện tượng | Kiểm tra |
|---|---|
| Không nhận tin | *Kết nối kênh*: “Webhook gần nhất”. Meta Dashboard → Webhooks: trạng thái gửi. *Cài đặt → Độ tin cậy*: webhook lỗi. Chữ ký sai → kiểm tra `META_APP_SECRET`. |
| Lỗi 190 khi gửi | Token bị thu hồi (đổi mật khẩu, gỡ quyền) → **Cấp quyền lại**. |
| Lỗi 551 | Người nhận không khả dụng (chặn trang, khoá tài khoản). |
| Bị chặn “quá 24 giờ” | Đúng chính sách; chờ khách nhắn lại. |
