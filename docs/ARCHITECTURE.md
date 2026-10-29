# Kiến trúc

## Giả định
- Một doanh nghiệp (SME) dùng một hoặc vài workspace; mỗi workspace có nhiều Fanpage và nhiều Zalo OA.
- Chỉ dùng API chính thức (Meta Messenger Platform, Zalo OA Open API). Không cookie, không scraping, không tự động hoá tài khoản cá nhân.
- MVP chỉ trả lời hội thoại **do khách khởi tạo**. Không có chiến dịch gửi hàng loạt, không gửi tin chủ động ngoài cửa sổ cho phép.
- Không lấy được lịch sử tin trước thời điểm kết nối kênh.
- Lưu thời gian UTC (`timestamptz`), hiển thị theo `Asia/Ho_Chi_Minh`.
- Tìm kiếm kiến thức dùng PostgreSQL full-text (không dấu) — đủ cho kho kiến thức SME; chưa cần pgvector.
- Không có thông tin xác thực Meta/Zalo trong môi trường xây dựng → tích hợp thật chưa được chạy thử với tài khoản thật (xem `TEST_REPORT.md`).

## Thành phần

```
                 Internet (HTTPS)
                       │
                  ┌────▼────┐
                  │  Caddy  │  tự cấp chứng chỉ, HSTS
                  └┬───┬───┬┘
         /api/*    │   │   │  /*            /socket.io/*
      ┌────────────▼┐  │  ┌▼──────────┐
      │  API (Nest) │◄─┘  │ Web (Next)│
      │ REST + WS   │     └───────────┘
      └──┬────┬─────┘
         │    │ BullMQ          ┌──────────────┐
         │    └────────────────►│ Worker (Nest)│ webhook, gửi tin, AI, kiến thức, bảo trì
         │                      └──┬───────────┘
   ┌─────▼─────┐  ┌───────┐  ┌─────▼─────┐
   │PostgreSQL │  │ Redis │  │ MinIO/S3  │
   └───────────┘  └───────┘  └───────────┘
```

- **API** (`apps/api/src/main.ts`): REST `/api/*`, WebSocket (socket.io, xác thực cookie), nhận webhook.
- **Worker** (`apps/api/src/worker.ts`): cùng mã nguồn, chạy các hàng đợi BullMQ: `webhook`, `outbound`, `ai`, `knowledge`, `maintenance` (quét outbox, quét webhook kẹt, làm mới token Zalo, xoá dữ liệu theo thời hạn lưu trữ, biên nhận mô phỏng). Worker phát sự kiện realtime qua `@socket.io/redis-emitter`.
- **Web** (`apps/web`): Next.js 15 + Tailwind, thành phần giao diện viết tay theo phong cách shadcn.

## Luồng tin đến

1. Nền tảng gọi `POST /api/webhooks/facebook|zalo`.
2. Kiểm tra chữ ký trên **đúng byte thô** nhận được; sai → 401, không lưu.
3. Phân tích thành sự kiện chuẩn hoá; mỗi sự kiện có khoá chống trùng `(provider, channelExternalId, eventKey)` (unique). Trùng → bỏ qua.
4. Lưu `WebhookEvent`, đưa vào hàng đợi, trả 200 ngay.
5. Worker xử lý dưới khoá `pg_advisory_xact_lock` theo hội thoại (tuần tự hoá từng hội thoại): tạo/cập nhật khách, danh tính, hội thoại, tin nhắn (unique `channelId + externalId`).
6. Sau commit: phát realtime, rồi gọi **AutomationService** (quy tắc → AI). Tin cũ (> 30 phút) hoặc không phải tin mới nhất không kích hoạt tự động.
7. Echo (tin trang/OA tự gửi): không kích hoạt bot; nếu có metadata `omni:<id>` thì đối soát với tin đã gửi; echo từ công cụ khác → đánh dấu “gửi từ công cụ khác” và tạm dừng bot (nhân viên đang trả lời ở nơi khác).
8. Biên nhận đã chuyển/đã đọc: lưu watermark trên hội thoại → xử lý đúng khi đến sai thứ tự.

## Luồng tin đi (transactional outbox)

1. Mọi tin đi (nhân viên, quy tắc, AI, duyệt nháp) đều qua `OutboxService.queueSend` — điểm vào duy nhất.
2. Khoá dòng hội thoại (`SELECT … FOR UPDATE`), chạy **SendPolicyService.check** (dịch vụ kiểm tra điều kiện tập trung):
   tách biệt demo/thật → kênh đã kết nối → loại tin & giới hạn nội dung theo kênh → người nhận còn nhận được → khách đã nhắn → cửa sổ gửi theo `PolicyRule` đang hiệu lực (theo loại người gửi) → (AI) ngân sách.
   Bị chặn → lưu tin trạng thái `BLOCKED` với lý do tiếng Việt, API trả 422 `SEND_BLOCKED`, giao diện giữ nguyên bản nháp.
3. Hợp lệ → tạo `Message(PENDING)` + `OutboundMessage(QUEUED)` cùng giao dịch; `clientMsgId` unique chống bấm gửi hai lần.
4. Worker chuyển `QUEUED → SENDING` dưới khoá, gọi adapter:
   - chấp nhận → `ACCEPTED` (lưu message id của nền tảng);
   - lỗi có thể thử lại (giới hạn tốc độ, 5xx trước khi gửi) → thử lại với backoff, tôn trọng giới hạn;
   - lỗi vĩnh viễn → `FAILED` (+ cập nhật trạng thái kênh nếu là lỗi token/quyền);
   - **timeout / mất kết nối sau khi đã gửi** → `UNKNOWN`, **không tự gửi lại**. Có thể đối soát sau qua echo. Nhân viên gửi lại phải xác nhận có thể trùng.
5. Tin bot/quy tắc đang chờ bị huỷ nếu nhân viên tiếp quản trước khi gửi.
6. Hàng đợi lỗi (dead-letter) xem và chạy lại ở *Cài đặt → Độ tin cậy*. Hệ thống **không** tuyên bố “đúng một lần”.

## Chatbot / AI

Thứ tự: từ khoá buộc chuyển nhân viên → ngân sách ngày/tháng → truy xuất đoạn tài liệu **đã duyệt** (FTS, lọc độ trùng khớp) → không có nguồn → chuyển nhân viên → gọi LLM với đầu ra JSON có cấu trúc (`answer`, `used_source_ids`, `needs_human`…) → **kiểm tra căn cứ phía máy chủ**: số liệu, URL, email trong câu trả lời phải xuất hiện trong nguồn đã trích dẫn, phải có ít nhất một nguồn. Độ tự tin do model tự báo không bao giờ là điều kiện duy nhất để tự gửi.
- Chế độ: Thủ công (không chạy) / Trợ lý (soạn nháp, nhân viên duyệt) / Tự động (gửi qua outbox nếu qua mọi kiểm tra; không qua → giữ nháp + chuyển nhân viên).
- Nội dung khách và tài liệu được bọc trong thẻ dữ liệu, prompt hệ thống yêu cầu coi là dữ liệu, bỏ qua mọi chỉ dẫn bên trong.
- Chỉ gửi tin gần nhất (và vài tin trước, không kèm SĐT/email/ghi chú nội bộ) + đoạn tài liệu liên quan.
- Nhân viên tiếp quản: `botPausedAt/botPausedById`, huỷ tác vụ AI đang chờ và tin bot đang xếp hàng; tác vụ đang chạy kiểm tra lại trạng thái tạm dừng ngay trước khi gửi. Bot chỉ chạy lại khi bấm “Bật lại bot”.

## Mô hình dữ liệu (rút gọn)

| Bảng | Vai trò | Ràng buộc chính |
|---|---|---|
| Workspace, Membership, MemberChannelAccess, User, Session | Tổ chức, vai trò, quyền theo kênh, phiên đăng nhập | unique (workspaceId,userId) |
| Channel, ChannelCredential, OAuthState | Fanpage/OA, token mã hoá AES-256-GCM (có version chống làm mới đồng thời) | unique (type, externalId) |
| Customer, CustomerIdentity, CustomerLinkEvent | Hồ sơ, danh tính theo kênh, nhật ký gộp | unique (channelId, externalUserId) |
| Conversation | Một hội thoại / danh tính; trạng thái, phân công, bot, watermark | unique identityId |
| Message, OutboundMessage | Tin nhắn, outbox | unique (channelId, externalId), unique (workspaceId, clientMsgId) |
| InternalNote | Ghi chú nội bộ (bảng riêng — không có đường gửi ra kênh) | |
| FileObject | Tệp (S3/local), sha256, kiểm tra magic bytes | unique storageKey |
| AssignmentEvent, Tag, ConversationTag, CustomerTag, CannedResponse | Phân công, nhãn, câu mẫu | |
| AutomationRule, RuleExecution | Quy tắc, lịch sử chạy | unique (ruleId, messageId) |
| KnowledgeDocument, KnowledgeChunk, AiSettings, AiTask | Kho kiến thức có phiên bản, cấu hình & tác vụ AI | unique triggerMessageId |
| WebhookEvent | Sự kiện thô đã nhận | unique (provider, channelExternalId, eventKey) |
| PolicyRule | Chính sách gửi có phiên bản, ngày hiệu lực, URL nguồn | |
| AuditLog | Nhật ký thao tác | |

Chỉ mục trigram (pg_trgm) cho tìm kiếm tin nhắn/khách hàng, GIN full-text cho đoạn tài liệu.

## Bảo mật
- Phiên: token ngẫu nhiên trong cookie `httpOnly`, `SameSite=Lax`, `Secure` khi HTTPS; DB chỉ lưu sha256.
- Chống CSRF: kiểm tra `Origin` cho mọi yêu cầu thay đổi dữ liệu.
- Đăng nhập: khoá 15 phút sau 5 lần sai; giới hạn theo IP (Redis).
- Phân quyền kiểm tra ở máy chủ cho API, WebSocket (chỉ vào phòng của kênh được cấp), tìm kiếm, xuất dữ liệu, URL tệp.
- Bí mật (token Meta/Zalo, API key AI) mã hoá AES-256-GCM, không trả về frontend, không ghi log (URL được che `access_token`).
- Tệp tải lên: giới hạn kích thước, danh sách MIME cho phép, kiểm tra magic bytes; tải xuống qua URL ký HMAC hết hạn sau 5 phút.
- Nhật ký thao tác cho kết nối kênh, phân quyền, chính sách, gộp/xoá khách, xuất dữ liệu, cấu hình AI.
- Thời hạn lưu trữ: tác vụ bảo trì xoá tin cũ hơn `retentionDays`.

## Các giai đoạn đã thực hiện
1. Nền tảng: schema, auth, phân quyền, workspace demo/thật.
2. Luồng đầu-cuối: webhook → hội thoại → hộp thư realtime → gửi qua outbox → biên nhận.
3. Quy tắc tự động (chào, ngoài giờ, từ khoá/ý định, FAQ, thu thập thông tin, chuyển nhân viên).
4. AI có căn cứ + kho kiến thức + ngân sách.
5. Kết nối kênh thật (OAuth Facebook chọn Page, Zalo OAuth v4 + PKCE, nhập token thủ công).
6. Báo cáo, cài đặt, nhật ký, độ tin cậy.
7. Kiểm thử, Docker Compose + Caddy, tài liệu.
