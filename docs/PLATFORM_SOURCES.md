# Nguồn tài liệu nền tảng & mức độ xác minh

Ngày kiểm tra: **29/10/2026**. Mọi endpoint, quyền và hạn chế dùng trong mã nguồn đều lấy từ các nguồn dưới đây. Không có endpoint nào được tự suy đoán.

Mức xác minh:
- **ĐÃ ĐỐI CHIẾU**: đọc trực tiếp tài liệu chính thức của nền tảng trong ngày kiểm tra.
- **NGUỒN PHỤ**: tài liệu chính thức không truy cập được từ môi trường xây dựng (trang Zalo for Developers là ứng dụng một trang, bị chặn mạng). Giá trị lấy từ mã nguồn SDK mã nguồn mở, bài viết cộng đồng Zalo và bài hướng dẫn kỹ thuật. **Chủ sở hữu cần đối chiếu lại trước khi chạy thật** (xem `ZALO_SETUP.md`, mục “Cần xác minh”).

Các giá trị chính sách (cửa sổ gửi tin) được lưu trong bảng `PolicyRule` kèm URL nguồn, mức xác minh và ngày hiệu lực; có thể tạo phiên bản mới ở trang *Cài đặt & nhật ký → Chính sách gửi tin* mà không cần sửa mã.

## Meta (Facebook Messenger Platform)

| Nội dung | Giá trị dùng trong hệ thống | Nguồn | Mức |
|---|---|---|---|
| Phiên bản Graph API | `v26.0` (phát hành 29/07/2026), cấu hình qua `META_GRAPH_VERSION` | https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/ , https://developers.facebook.com/docs/graph-api/changelog/version26.0 | ĐÃ ĐỐI CHIẾU |
| Gửi tin | `POST https://graph.facebook.com/v26.0/{PAGE_ID}/messages` với `recipient.id` (PSID), `messaging_type`, `message.text` / `message.attachment`, `message.metadata` | https://developers.facebook.com/docs/messenger-platform/reference/send-api | ĐÃ ĐỐI CHIẾU |
| Loại tin & cửa sổ 24 giờ | `messaging_type=RESPONSE` trong 24 giờ kể từ tin của người dùng | https://developers.facebook.com/docs/messenger-platform/send-messages | ĐÃ ĐỐI CHIẾU |
| Tag HUMAN_AGENT | `messaging_type=MESSAGE_TAG`, `tag=HUMAN_AGENT`, trong 7 ngày, chỉ cho phản hồi của người thật, cần được Meta duyệt quyền Human Agent | https://developers.facebook.com/docs/messenger-platform/send-messages | ĐÃ ĐỐI CHIẾU |
| Webhook: xác minh URL | `GET` với `hub.mode=subscribe`, `hub.verify_token`, trả `hub.challenge` | https://developers.facebook.com/docs/messenger-platform/webhooks | ĐÃ ĐỐI CHIẾU |
| Webhook: chữ ký | Header `X-Hub-Signature-256: sha256=<HMAC-SHA256(raw body, App Secret)>` | https://developers.facebook.com/docs/messenger-platform/webhooks | ĐÃ ĐỐI CHIẾU |
| Sự kiện | `messages`, `message_echoes` (có `is_echo`, `app_id`, `metadata`), `message_deliveries` (watermark), `message_reads` (watermark), `messaging_postbacks` | https://developers.facebook.com/docs/messenger-platform/webhooks | ĐÃ ĐỐI CHIẾU |
| Đăng ký Page nhận webhook | `POST /{PAGE_ID}/subscribed_apps?subscribed_fields=messages,message_echoes,message_deliveries,message_reads,messaging_postbacks` bằng Page access token | https://developers.facebook.com/docs/messenger-platform/webhooks | ĐÃ ĐỐI CHIẾU |
| Quyền | `pages_messaging` (phụ thuộc `pages_manage_metadata`, `pages_show_list`), `pages_read_engagement` để đọc thông tin trang | https://developers.facebook.com/docs/permissions | ĐÃ ĐỐI CHIẾU |
| Token dài hạn | User token dài hạn ~60 ngày; Page token lấy từ user token dài hạn không có ngày hết hạn | https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived | ĐÃ ĐỐI CHIẾU |
| Mã lỗi | 190 token không hợp lệ; 4/17/32/613 giới hạn tốc độ; 200–299 thiếu quyền; 551 người nhận không khả dụng | https://developers.facebook.com/docs/messenger-platform/reference/send-api | ĐÃ ĐỐI CHIẾU (551, 190); mã giới hạn tốc độ theo tài liệu Graph API chung |
| `appsecret_proof` | HMAC-SHA256(access_token, App Secret) gửi kèm lời gọi Graph API | https://developers.facebook.com/docs/graph-api/securing-requests | Theo tài liệu Graph API (không bắt buộc trừ khi bật trong cài đặt ứng dụng) |

Lưu ý nền tảng:
- Nền tảng **không** cho phép lấy lịch sử tin nhắn trước thời điểm kết nối qua webhook; hệ thống không giả định có lịch sử cũ.
- Trạng thái *Đã chuyển / Đã xem* chỉ hiển thị khi Meta gửi sự kiện `message_deliveries` / `message_reads`.

## Zalo Official Account

| Nội dung | Giá trị dùng trong hệ thống | Nguồn | Mức |
|---|---|---|---|
| Cấp quyền OA (OAuth v4 + PKCE) | `https://oauth.zaloapp.com/v4/oa/permission?app_id&redirect_uri&code_challenge&state`; callback trả `code`, `oa_id` | https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new | NGUỒN PHỤ |
| Đổi mã lấy token | `POST https://oauth.zaloapp.com/v4/oa/access_token`, header `secret_key: <App Secret>`, form `app_id, code, grant_type=authorization_code, code_verifier` | như trên; @warriorteam/redai-zalo-sdk (mã nguồn) | NGUỒN PHỤ |
| Làm mới token | Cùng endpoint, `grant_type=refresh_token`, `refresh_token`, `app_id`. **Refresh token dùng một lần**: mỗi lần làm mới phải lưu refresh token mới | như trên; https://developers.zalo.me/community/detail/8f3011d52d90c4ce9d81 | NGUỒN PHỤ |
| Thời hạn token | Access token ~1 giờ (dùng `expires_in` trả về); refresh token ~3 tháng | như trên | NGUỒN PHỤ |
| Gửi tin tư vấn | `POST https://openapi.zalo.me/v3.0/oa/message/cs`, header `access_token`, body `{recipient:{user_id}, message:{text}}` | https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van | NGUỒN PHỤ |
| Cửa sổ tin tư vấn | 48 giờ kể từ tương tác gần nhất của người dùng | như trên | NGUỒN PHỤ |
| Ảnh / tệp | Ảnh JPG/PNG ≤ 1MB qua template media; tệp ≤ 5MB tải lên `POST /v2.0/oa/upload/file` lấy `token` | SDK mã nguồn mở | NGUỒN PHỤ |
| Thông tin OA (xác minh kết nối) | `GET https://openapi.zalo.me/v2.0/oa/getoa`, header `access_token` | SDK mã nguồn mở | NGUỒN PHỤ |
| Chữ ký webhook | Header `X-ZEvent-Signature: mac=<sha256(app_id + raw body + timestamp + OA Secret Key)>` (`timestamp` trong body) | https://hainh.me/zalo-api-php-webhook-callback-official-account.html ; cộng đồng Zalo | NGUỒN PHỤ |
| Sự kiện webhook | `user_send_text`, `user_send_image`, `user_send_file`, `user_send_sticker`…, `oa_send_*` (echo), `user_seen_message`, `user_received_message`, `follow`, `unfollow` | như trên | NGUỒN PHỤ |
| Mã lỗi | `-216` access token không hợp lệ, `-124` access token hết hạn (làm mới một lần rồi gửi lại); `-223` vượt hạn mức; `-213` người dùng chưa quan tâm OA / không nhận được tin | cộng đồng Zalo, SDK | NGUỒN PHỤ |

## Nhà cung cấp AI

| Nội dung | Giá trị | Nguồn |
|---|---|---|
| Anthropic SDK | `@anthropic-ai/sdk` 1.3.0, model mặc định gợi ý `claude-opus-5-5` | Tài liệu SDK đi kèm công cụ phát triển, kiểm tra 29/10/2026 |
| Đơn giá | Do quản trị viên nhập (USD / 1 triệu token); hệ thống không tự giả định giá | — |
