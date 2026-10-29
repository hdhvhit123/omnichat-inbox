# OmniChat Inbox

Hệ thống quản lý tin nhắn tập trung cho doanh nghiệp vừa và nhỏ: nhiều **Facebook Fanpage** và nhiều **Zalo Official Account** trong một hộp thư, có quy tắc tự động, chatbot AI trả lời dựa trên tài liệu đã duyệt, và công cụ chăm sóc khách hàng cho nhân viên.

- Chỉ dùng API chính thức (Meta Messenger Platform, Zalo OA Open API). Không cookie, không scraping, không tự động hoá tài khoản cá nhân.
- Giao diện và thông báo tiếng Việt; thời gian lưu UTC, hiển thị giờ Việt Nam.
- **Trạng thái tích hợp**: đã kiểm thử đầy đủ với nền tảng giả lập và chế độ demo; **chưa chạy với tài khoản Meta/Zalo thật** (cần thông tin từ chủ sở hữu — xem [`docs/OWNER_CHECKLIST.md`](docs/OWNER_CHECKLIST.md)).

## Tính năng
- **Hộp thư 3 cột realtime**: lọc theo kênh, tài khoản, người phụ trách, nhãn, trạng thái (Mới / Đang xử lý / Chờ khách / Đã giải quyết); tìm kiếm; tải lịch sử; gửi văn bản và tệp; câu trả lời mẫu (`/`); ghi chú nội bộ (không bao giờ gửi ra kênh); phân công; cảnh báo hội thoại chờ lâu; hiển thị ai đang xem/đang soạn; phân biệt tin khách / nhân viên / bot / ghi chú.
- **Trạng thái gửi thật**: Đang gửi, Nền tảng đã nhận, Đã chuyển, Đã xem, Thất bại, Chưa xác định — *Đã chuyển/Đã xem* chỉ khi nền tảng xác nhận. Timeout → *Chưa xác định*, không tự gửi lại.
- **Dịch vụ kiểm tra điều kiện gửi tập trung** cho mọi tin đi: quyền, loại tin, tương tác gần nhất, cửa sổ gửi (chính sách có phiên bản, ngày hiệu lực, URL nguồn), người nhận, ngân sách. Bị chặn → giải thích tiếng Việt, giữ bản nháp.
- **Khách hàng**: hồ sơ đa kênh; không tự gộp theo tên/ảnh; gộp thủ công có lý do và nhật ký; xoá dữ liệu khách.
- **Quy tắc tự động**: chào (một lần), ngoài giờ, từ khoá/ý định (không dấu), FAQ, thu thập thông tin (tên → SĐT → nhu cầu), chuyển nhân viên; ưu tiên, thời gian nghỉ, số lần tối đa, lịch sử, chế độ thử, công cụ thử; chống lặp.
- **Chatbot AI**: Thủ công / Trợ lý / Tự động; kho kiến thức FAQ, văn bản, PDF, DOCX có phiên bản và duyệt; kiểm tra căn cứ phía máy chủ (không bịa giá/chính sách); hiển thị nguồn; chống prompt injection; chuyển nhân viên khi cần; nhân viên tiếp quản dừng bot ngay; ngân sách và chi phí.
- **Kết nối kênh**: Facebook Login chọn Page, Zalo OAuth v4 + PKCE, nhập token thủ công; trạng thái, webhook gần nhất, API thành công gần nhất, lỗi; kiểm tra / cấp quyền lại / ngắt kết nối.
- **Nhân viên & phân quyền**: Chủ sở hữu, Quản lý, Nhân viên, Người xem — kiểm tra ở máy chủ cho API, WebSocket, tìm kiếm, xuất dữ liệu, tải tệp.
- **Báo cáo** có định nghĩa chỉ số; **Cài đặt & nhật ký**: giờ làm việc, lưu trữ, chính sách gửi, webhook lỗi, hàng đợi lỗi, nhật ký thao tác, xuất CSV.
- **Chế độ demo**: workspace “Dữ liệu mô phỏng” tách biệt, kênh giả lập, công cụ tạo tin đến và giả lập lỗi; không bao giờ gọi nền tảng thật.

## Công nghệ
Next.js 15 · TypeScript · Tailwind · NestJS 11 · PostgreSQL 16 + Prisma 6 · Redis + BullMQ · socket.io · S3 (MinIO) · Docker Compose + Caddy (HTTPS tự động).

```
apps/api     API (REST + WebSocket + webhook) và worker (cùng mã nguồn, 2 tiến trình)
apps/web     Giao diện Next.js
deploy/      docker-compose.yml, Caddyfile, .env.example
docs/        Tài liệu
e2e/         Kịch bản kiểm thử giao diện bằng trình duyệt
```

## Chạy thử cục bộ
Yêu cầu: Node 22, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
createdb omnichat                         # migration tự bật pg_trgm (cần quyền tạo extension)
cp apps/api/.env.example apps/api/.env    # điền ENCRYPTION_KEY=$(openssl rand -base64 32)
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate && pnpm db:seed
pnpm dev:api      # cổng 4000
pnpm dev:worker
pnpm dev:web      # http://localhost:3000
```

Tài khoản demo (mật khẩu `Demo@12345`, đổi bằng `SEED_DEMO_PASSWORD`): `owner@demo.local`, `manager@demo.local`, `agent@demo.local`, `viewer@demo.local`. Chủ sở hữu có thêm workspace thật trống để kết nối kênh thật.

## Triển khai (HTTPS)
```bash
cd deploy
cp .env.example .env      # điền DOMAIN, mật khẩu, ENCRYPTION_KEY, thông tin Meta/Zalo
docker compose up -d --build
docker compose exec -e SEED_DEMO=false -e SEED_OWNER_EMAIL=ban@congty.vn \
  -e SEED_OWNER_PASSWORD='mat-khau-manh' api npx ts-node --transpile-only prisma/seed.ts
```
Caddy tự cấp chứng chỉ cho `DOMAIN`. Migration chạy tự động khi API khởi động. Webhook: `https://DOMAIN/api/webhooks/facebook` và `https://DOMAIN/api/webhooks/zalo`.

## Kiểm thử
```bash
createdb omnichat_test
DATABASE_URL=postgresql://omni:omni@localhost:5432/omnichat_test pnpm db:migrate
pnpm test                # 40 kiểm thử, nền tảng được giả lập (TEST_DATABASE_URL để đổi DB)
```
Kết quả và phân loại mock/thật: [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md).

## Tài liệu
- [Kiến trúc, giả định, luồng dữ liệu, mô hình dữ liệu](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Kết nối Facebook (Meta) từng bước + App Review](docs/META_SETUP.md)
- [Kết nối Zalo OA từng bước](docs/ZALO_SETUP.md)
- [Nguồn tài liệu nền tảng, ngày kiểm tra, mức xác minh](docs/PLATFORM_SOURCES.md)
- [Việc chủ sở hữu cần chuẩn bị](docs/OWNER_CHECKLIST.md)
- [Báo cáo kiểm thử & hạn chế đã biết](docs/TEST_REPORT.md)
