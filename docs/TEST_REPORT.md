# Báo cáo kiểm thử

Ngày chạy: 29/10/2026. Môi trường: Node 22, PostgreSQL 16, Redis 7 (cục bộ trong container phát triển).

## Phân loại rõ ràng

| Loại | Có chạy? | Ghi chú |
|---|---|---|
| **Kiểm thử tự động với nền tảng giả lập** (Jest + Supertest + máy chủ HTTP giả Facebook/Zalo) | ✅ 40/40 đạt | Gọi API thật của hệ thống, DB thật, hàng đợi chạy inline. Facebook/Zalo được thay bằng máy chủ HTTP cục bộ trả phản hồi theo định dạng tài liệu |
| **Kiểm thử giao diện bằng trình duyệt thật** (Playwright, workspace demo) | ✅ đạt | Qua `next start` cục bộ và qua toàn bộ Docker Compose + Caddy HTTPS |
| **Kiểm thử tích hợp thật với Facebook/Zalo** | ❌ **chưa chạy** | Môi trường không có App ID/Secret, Page hay OA được cấp quyền. Không tuyên bố đã tích hợp thành công. Xem `OWNER_CHECKLIST.md` |

Lệnh: `pnpm test` (tại thư mục gốc) — cần PostgreSQL với DB `omnichat_test` và Redis.

## Kết quả kiểm thử tự động (mock)

```
Test Suites: 6 passed, 6 total
Tests:       40 passed, 40 total
```

### webhook.spec.ts — Webhook: chữ ký, chống trùng, echo
- ✅ xác minh URL webhook Facebook bằng verify token
- ✅ từ chối webhook Facebook sai chữ ký và không lưu gì
- ✅ từ chối webhook Zalo sai chữ ký
- ✅ chấp nhận webhook Zalo đúng chữ ký
- ✅ webhook trùng không tạo hai tin hay hai câu trả lời
- ✅ xử lý lại cùng một sự kiện (job chạy lại) không gửi lại câu trả lời
- ✅ tin echo không kích hoạt bot; echo có metadata đối soát với tin đã gửi
- ✅ xác nhận đã đọc đến trước phản hồi/echo vẫn cập nhật đúng (sai thứ tự)

### access.spec.ts — Phân quyền & cách ly workspace
- ✅ không truy cập chéo workspace: API, tìm kiếm, gửi tin, tệp, khách hàng
- ✅ nhân viên chỉ thấy hội thoại thuộc kênh được cấp hoặc được giao
- ✅ người xem chỉ đọc
- ✅ WebSocket: không vào được phòng của workspace khác và không nhận sự kiện của nó

### policy-notes.spec.ts — Kiểm tra điều kiện gửi & ghi chú nội bộ
- ✅ Facebook trong 24 giờ: gửi với messaging_type RESPONSE
- ✅ hết cửa sổ gửi tin Facebook thì bị chặn, giải thích tiếng Việt, không gọi API
- ✅ tag HUMAN_AGENT chỉ dùng khi workspace bật và chỉ cho nhân viên
- ✅ Zalo quá 48 giờ bị chặn; trong 48 giờ gửi tin tư vấn
- ✅ bấm gửi hai lần cùng clientMsgId chỉ tạo một tin
- ✅ ghi chú nội bộ không thể gửi ra kênh

### takeover-demo.spec.ts — AI: tiếp quản, căn cứ, chế độ demo
- ✅ AI tự động trả lời có căn cứ từ tài liệu đã duyệt
- ✅ không có tài liệu phù hợp → chuyển nhân viên, không bịa câu trả lời
- ✅ AI bịa con số không có trong tài liệu → không tự gửi, giữ nháp cho nhân viên
- ✅ nhân viên tiếp quản khi AI đang chạy thì bot không gửi
- ✅ tin bot đã xếp hàng bị huỷ nếu nhân viên tiếp quản trước khi gửi
- ✅ chế độ demo không gọi API gửi thật
- ✅ công cụ mô phỏng bị chặn ở workspace thật; kênh mô phỏng không gửi được trong workspace thật

### platform-errors.spec.ts — Lỗi nền tảng
- ✅ Facebook token hết hạn (190): tin thất bại, kênh chuyển trạng thái lỗi, không retry
- ✅ Facebook rate limit: giữ chờ gửi, lên lịch thử lại có backoff, lần sau thành công
- ✅ timeout: đánh dấu chưa xác định, KHÔNG retry mù; echo sau đó đối soát thành đã gửi
- ✅ Zalo access token hết hạn: làm mới một lần rồi gửi lại thành công
- ✅ nhiều tiến trình cùng làm mới token Zalo chỉ gọi API refresh một lần
- ✅ refresh token Zalo không hợp lệ: kênh báo lỗi cần cấp quyền lại

### unit.spec.ts — Hàm thuần
- ✅ chuẩn hoá tiếng Việt khi so khớp nhưng không đổi nội dung gốc
- ✅ số điện thoại Việt Nam
- ✅ quy tắc theo kênh, từ khoá, ý định
- ✅ giờ làm việc theo múi giờ Asia/Ho_Chi_Minh
- ✅ kiểm tra căn cứ AI chặn số liệu/link không có trong nguồn
- ✅ chia đoạn FAQ theo cặp hỏi/đáp
- ✅ chữ ký Facebook trên đúng byte nhận được
- ✅ phân tích sự kiện Zalo: tin khách, echo OA, đã đọc
- ✅ che SĐT và email trước khi gửi sang nhà cung cấp AI

### Đối chiếu với danh sách kiểm thử bắt buộc
| Yêu cầu | Kiểm thử |
|---|---|
| Webhook trùng | webhook: “webhook trùng…”, “xử lý lại cùng một sự kiện…” |
| Sai chữ ký | webhook: Facebook + Zalo sai chữ ký |
| Truy cập chéo workspace | access: API, tìm kiếm, gửi, tệp, khách hàng, WebSocket |
| Hết cửa sổ gửi | policy-notes: Facebook 24h, Zalo 48h, HUMAN_AGENT |
| Tiếp quản khi AI đang chạy | takeover-demo: 2 kiểm thử |
| Echo không kích hoạt bot | webhook: echo |
| Token hết hạn / rate limit / timeout | platform-errors: 6 kiểm thử |
| Ghi chú không gửi được | policy-notes: ghi chú nội bộ |
| Demo không gọi API thật | takeover-demo: 2 kiểm thử (máy chủ giả ghi nhận 0 lời gọi) |

## Kiểm thử giao diện (trình duyệt thật, workspace demo)

Kịch bản `e2e/smoke-inbox.js` và `e2e/smoke-failure.js`, chạy 3 lần liên tiếp đều đạt, không có lỗi JavaScript:
- Đăng nhập Quản lý → Tổng quan; chỉ báo realtime “đã kết nối”.
- Công cụ mô phỏng tạo tin Facebook (định dạng webhook thật, đi qua chữ ký → hàng đợi → worker) → hội thoại xuất hiện realtime.
- Lời chào tự động gửi một lần; AI ở chế độ Trợ lý tạo bản nháp có nguồn.
- Nhân viên trả lời → bot tự tạm dừng (nhân viên đã trả lời) → trạng thái tin chuyển *Nền tảng đã nhận → Đã xem* theo biên nhận mô phỏng.
- Ghi chú nội bộ hiển thị riêng (nền vàng, biểu tượng khoá), không có trạng thái gửi.
- Đăng nhập Nhân viên → giả lập *timeout* → tin hiện *Chưa xác định*; bấm *Gửi lại* hiện hộp xác nhận “có thể đã tới khách”.
- Mở đủ 10 trang chức năng không lỗi.

Docker: build image API/Web, chạy `deploy/docker-compose.yml` (Postgres, Redis, API, worker, web, Caddy) với `DOMAIN=localhost` → migration tự chạy, seed, đăng nhập và toàn bộ kịch bản trên qua `https://localhost` (Caddy, WebSocket qua proxy) đạt.
Ghi chú môi trường kiểm thử: mạng sandbox chặn Docker Hub/Debian mirror nên khi build thử đã dùng ảnh từ mirror và bỏ bước `apt-get install openssl` (Prisma vẫn chạy nhưng cảnh báo); MinIO không tải được nên dùng `STORAGE_DRIVER=local`. Dockerfile trong repo giữ nguyên bước cài openssl và cấu hình MinIO cho môi trường thật.

## Hạn chế đã biết
1. **Chưa thử với tài khoản Meta/Zalo thật.** Toàn bộ tích hợp thật cần chủ sở hữu cung cấp ứng dụng, quyền và tên miền HTTPS (xem `OWNER_CHECKLIST.md`).
2. **Zalo dựa trên nguồn phụ** (tài liệu chính thức không truy cập được): chữ ký webhook, endpoint gửi tin, cửa sổ 48 giờ, mã lỗi cần đối chiếu (`ZALO_SETUP.md`).
3. Gửi tệp Facebook dùng URL ký có hạn 1 giờ qua tên miền công khai — Meta phải tải được URL này (không chạy được sau tường lửa nội bộ).
4. Không lấy lịch sử tin trước khi kết nối; không hỗ trợ gửi tin chủ động/chiến dịch, ZNS, tin giao dịch/truyền thông Zalo, bình luận bài viết.
5. Ảnh/tệp khách gửi được hiển thị bằng liên kết của nền tảng (có thể hết hạn sau một thời gian); hệ thống chưa tải về lưu trữ riêng.
6. Tìm kiếm kiến thức dùng full-text không dấu (không phải vector) — câu hỏi diễn đạt rất khác tài liệu có thể không tìm thấy → chuyển nhân viên (an toàn, không bịa).
7. Phí nền tảng (nếu có) chưa có nguồn dữ liệu xác thực → báo cáo ghi rõ “chưa có dữ liệu”.
8. Mật khẩu tạm cho thành viên mới hiển thị một lần; chưa có gửi email mời / đổi mật khẩu tự phục vụ / 2FA.
9. Giao diện tối ưu cho máy tính (≥ 1280px); trên điện thoại dùng được nhưng chưa tối ưu bố cục 3 cột.
10. Trạng thái “đang xem/đang soạn” là tín hiệu tạm thời (không lưu), có thể trễ vài giây.
