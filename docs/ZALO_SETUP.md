# Hướng dẫn kết nối Zalo Official Account

> ⚠️ Tài liệu chính thức Zalo for Developers không truy cập được từ môi trường xây dựng. Endpoint và tham số lấy từ nguồn phụ (SDK mã nguồn mở, cộng đồng Zalo) — xem `PLATFORM_SOURCES.md`. **Cần đối chiếu mục “Cần xác minh” trước khi chạy thật.**

## 0. Cần chuẩn bị (chủ sở hữu)
- Zalo Official Account đã **xác thực** (OA doanh nghiệp). Tính năng gửi tin tư vấn qua API phụ thuộc gói dịch vụ OA — kiểm tra tại https://oa.zalo.me.
- Tài khoản Zalo là **quản trị viên OA**.
- Tên miền HTTPS công khai trỏ về máy chủ.

## 1. Tạo ứng dụng Zalo
1. Vào https://developers.zalo.me → **Tạo ứng dụng**.
2. Ghi lại **App ID** và **Khoá bí mật của ứng dụng (App Secret)**.
3. Mục **Official Account** → liên kết OA với ứng dụng; cấp các quyền gửi/nhận tin, đọc thông tin OA và người dùng.
4. **Callback URL** (đăng nhập OA): `https://inbox.congty.vn/api/oauth/zalo/callback`
5. Mục **Webhook**:
   - URL: `https://inbox.congty.vn/api/webhooks/zalo`
   - Bật các sự kiện: người dùng gửi tin (văn bản, ảnh, tệp, sticker…), OA gửi tin (echo), người dùng đã nhận/đã xem tin, quan tâm/bỏ quan tâm.
   - Ghi lại **OA Secret Key** của webhook (dùng kiểm tra chữ ký).
6. Xác thực tên miền theo hướng dẫn trên trang (nếu được yêu cầu).

## 2. Cấu hình máy chủ
```
ZALO_APP_ID=<App ID>
ZALO_APP_SECRET=<App Secret>
ZALO_OA_SECRET_KEY=<OA Secret Key của webhook>
```
`docker compose up -d api worker`.

## 3. Kết nối OA
1. Đăng nhập **Chủ sở hữu**, chọn workspace thật → *Kết nối kênh* → **Kết nối Zalo OA**.
2. Đăng nhập Zalo, chọn OA, đồng ý cấp quyền (OAuth v4 + PKCE).
3. Hệ thống đổi mã lấy access/refresh token (mã hoá khi lưu), gọi `getoa` xác minh. Chỉ hiển thị **Đã kết nối** khi xác minh thành công.
4. Kiểm tra đầu-cuối: dùng tài khoản Zalo đã **quan tâm OA** gửi tin → xuất hiện trong Hộp thư → trả lời → tin tới Zalo. **Chỉ coi là tích hợp thành công sau bước này.**

## 4. Quản lý token
- Access token ngắn hạn (~1 giờ); refresh token dài hạn (~3 tháng) và **chỉ dùng được một lần**.
- Worker tự làm mới trước khi hết hạn; khi gửi gặp lỗi token (-216/-124) sẽ làm mới **một lần** rồi gửi lại.
- Làm mới được bảo vệ bằng khoá dòng DB + kiểm tra phiên bản: nhiều tiến trình cùng lúc chỉ gọi API làm mới một lần, luôn lưu refresh token mới.
- Refresh token hết hạn/không hợp lệ → kênh chuyển **Lỗi**, cần **Cấp quyền lại**.

## 5. Hạn chế đã áp dụng
- Tin tư vấn chỉ gửi trong **48 giờ** kể từ tương tác gần nhất của người dùng (cấu hình trong `PolicyRule`, mức NGUỒN PHỤ).
- Không tự chuyển sang loại tin khác (giao dịch, truyền thông, ZNS) để vượt hạn chế — MVP không hỗ trợ các loại này.
- Ảnh JPG/PNG ≤ 1MB, tệp ≤ 5MB.
- Người dùng chưa quan tâm OA / chặn OA có thể không nhận được tin (lỗi -213) → hồ sơ đánh dấu “không nhận được tin”.

## Cần xác minh với tài liệu chính thức (chủ sở hữu/kỹ thuật)
1. Công thức chữ ký webhook: `mac = sha256(app_id + raw_body + timestamp + OA_secret_key)` trong header `X-ZEvent-Signature` (`apps/api/src/webhooks/signature.ts`).
2. Endpoint và body gửi tin tư vấn `v3.0/oa/message/cs` (`apps/api/src/channels/adapters/zalo.adapter.ts`).
3. Thời hạn cửa sổ tin tư vấn (48 giờ) và hạn mức theo gói OA → nếu khác, tạo phiên bản `PolicyRule` mới ở *Cài đặt → Chính sách gửi tin*.
4. Mã lỗi -216, -124, -223, -213.
5. Tên sự kiện webhook (`user_send_text`, `oa_send_text`, `user_seen_message`, …) trong `apps/api/src/webhooks/zalo.parser.ts`.
