# API

Tiền tố: `/api`. Định dạng JSON. Lỗi: `{ "code": "...", "message": "<tiếng Việt>", ...extra }`.

**Xác thực**: cookie phiên `omni_session` (httpOnly) nhận từ `POST /api/auth/login`. Các yêu cầu thay đổi dữ liệu phải có header `Origin` thuộc `CORS_ORIGINS`.
**Workspace**: header `x-workspace-id: <id>` cho mọi endpoint theo workspace (lấy danh sách từ `GET /api/auth/me`).
**Vai trò**: O = Chủ sở hữu, M = Quản lý, A = Nhân viên, V = Người xem. “Tất cả” = O/M/A/V. Nhân viên chỉ thấy hội thoại thuộc kênh được cấp hoặc được giao.

## Xác thực
| Phương thức | Đường dẫn | Vai trò | Mô tả |
|---|---|---|---|
| POST | `/auth/login` | công khai | `{email, password}` → đặt cookie. Khoá 15 phút sau 5 lần sai |
| POST | `/auth/logout` | đã đăng nhập | |
| POST | `/auth/logout-others` | đã đăng nhập | Thu hồi các phiên khác |
| GET | `/auth/me` | đã đăng nhập | Người dùng + danh sách workspace & vai trò |

## Hội thoại & hộp thư
| Phương thức | Đường dẫn | Vai trò | Mô tả |
|---|---|---|---|
| GET | `/conversations` | Tất cả | Lọc: `status` (NEW/OPEN/PENDING/RESOLVED/ACTIVE), `channelType`, `channelId`, `assignee` (userId/me/none), `tagId`, `q`, `cursor`, `limit` |
| GET | `/conversations/unhandled-count` | Tất cả | Số hội thoại có tin chưa đọc chưa xử lý |
| GET | `/conversations/:id` | Tất cả | Chi tiết + khách + `sendWindow` (cửa sổ gửi hiện tại, chỉ để hiển thị) |
| GET | `/conversations/:id/timeline` | Tất cả | Tin nhắn + ghi chú, `before=<ISO>` để tải cũ hơn |
| POST | `/conversations/:id/messages` | O/M/A | `{text? , fileId?, clientMsgId}` → 422 `SEND_BLOCKED` kèm `reasonCode` nếu không đủ điều kiện |
| POST | `/conversations/:id/messages/:messageId/resend` | O/M/A | Gửi lại tin FAILED/UNKNOWN; UNKNOWN cần `{confirmPossibleDuplicate:true}` (409 `CONFIRM_DUPLICATE`) |
| POST | `/conversations/:id/notes` | O/M/A | Ghi chú nội bộ (không bao giờ gửi ra kênh) |
| POST | `/conversations/:id/assign` | O/M/A | `{userId|null}`; nhân viên chỉ tự nhận/nhả |
| POST | `/conversations/:id/status` | O/M/A | `{status}` |
| POST | `/conversations/:id/takeover` | O/M/A | Tiếp quản: dừng bot, huỷ tác vụ AI và tin bot đang chờ |
| POST | `/conversations/:id/resume-bot` | O/M/A | Bật lại bot (ghi nhật ký) |
| PATCH | `/conversations/:id/bot-mode` | O/M | `{mode: MANUAL|ASSIST|AUTO|null}` |
| POST | `/conversations/:id/read` | O/M/A | Đánh dấu đã đọc |
| POST / DELETE | `/conversations/:id/tags`, `/conversations/:id/tags/:tagId` | O/M/A | Nhân viên chỉ gắn nhãn có sẵn |
| POST | `/conversations/:id/typing` | O/M/A | Báo đang soạn |
| GET | `/conversations/:id/ai-tasks` | Tất cả | Tác vụ AI gần nhất |
| POST | `/conversations/:id/ai-suggest` | O/M/A | AI soạn nháp cho tin khách gần nhất |
| POST | `/ai-tasks/:taskId/approve` | O/M/A | `{text?}` duyệt (có thể sửa) và gửi qua outbox |
| POST | `/ai-tasks/:taskId/discard` | O/M/A | Bỏ nháp |

## Khách hàng
| Phương thức | Đường dẫn | Vai trò | Mô tả |
|---|---|---|---|
| GET | `/customers?q&cursor` | Tất cả (theo phạm vi) | |
| GET | `/customers/:id` | Tất cả (theo phạm vi) | + danh tính, hội thoại, lịch sử liên kết |
| PATCH | `/customers/:id` | O/M/A | `displayName, phone, email, notes, tagIds` |
| POST | `/customers/merge` | O/M | `{sourceId, targetId, reason, evidence?}` — gộp thủ công, ghi nhật ký |
| DELETE | `/customers/:id?confirm=DELETE` | O | Xoá hồ sơ, hội thoại, tin, tệp |

## Thư viện
| Phương thức | Đường dẫn | Vai trò |
|---|---|---|
| GET | `/tags`, `/canned` | Tất cả |
| POST / DELETE | `/tags`, `/tags/:id` | O/M |
| POST / PATCH / DELETE | `/canned`, `/canned/:id` | O/M |

## Quy tắc tự động
| Phương thức | Đường dẫn | Vai trò | Mô tả |
|---|---|---|---|
| GET | `/rules` | Tất cả | + danh sách ý định có sẵn |
| POST / PATCH / DELETE | `/rules`, `/rules/:id` | O/M | Trường: `name, enabled, testMode, trigger, channelTypes, channelIds, priority, conditions{keywords,match,excludeKeywords,intents}, actions[], isGreeting, cooldownSeconds, maxRunsPerConversation` |
| GET | `/rules/:id/executions` | Tất cả | Lịch sử chạy |
| POST | `/rules/test` | Tất cả | `{text, channelType, isNewConversation?, at?}` — thử, không gửi |

## Chatbot & kho kiến thức
| Phương thức | Đường dẫn | Vai trò | Mô tả |
|---|---|---|---|
| GET / PUT | `/ai/settings` | GET: O/M; PUT: O/M | Nhà cung cấp, model, giới hạn token, ngân sách, đơn giá, từ khoá chuyển người. API key chỉ ghi |
| GET | `/knowledge`, `/knowledge/:id` | Tất cả | |
| POST | `/knowledge` | O/M | `{title, sourceType: FAQ|TEXT|PDF|DOCX, rawText?, fileId?, groupId?}` (groupId = phiên bản mới) |
| POST | `/knowledge/:id/approve` | O/M | `{approved}` |
| POST | `/knowledge/:id/reprocess` | O/M | |
| DELETE | `/knowledge/:id` | O/M | |
| POST | `/knowledge/search` | Tất cả | `{q}` thử truy xuất |

## Kênh
| Phương thức | Đường dẫn | Vai trò | Mô tả |
|---|---|---|---|
| GET | `/channels` | Tất cả (theo phạm vi) | Trạng thái, webhook gần nhất, API thành công gần nhất, lỗi, hạn token |
| PATCH | `/channels/:id` | O/M | `{botMode?, name?}` |
| POST | `/channels/:id/test` | O/M | Xác minh bằng API nền tảng |
| POST | `/channels/:id/disconnect` | O | Xoá token, huỷ đăng ký webhook (Facebook) |
| POST | `/channels/manual` | O | Nhập token thủ công, xác minh ngay |
| GET | `/channels/facebook/connect-url` | O | URL Facebook Login |
| GET | `/oauth/facebook/callback` | công khai (state) | |
| GET / POST | `/channels/facebook/pages` | O | Liệt kê / kết nối Page đã chọn |
| GET | `/channels/zalo/connect-url` | O | URL cấp quyền OA (PKCE) |
| GET | `/oauth/zalo/callback` | công khai (state) | |

## Webhook (nền tảng gọi)
| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/webhooks/facebook` | Xác minh `hub.verify_token` |
| POST | `/webhooks/facebook` | Kiểm tra `X-Hub-Signature-256` |
| POST | `/webhooks/zalo` | Kiểm tra `X-ZEvent-Signature` |

## Tệp
| Phương thức | Đường dẫn | Vai trò | Mô tả |
|---|---|---|---|
| POST | `/files` (multipart `file`) | O/M/A | Kiểm tra kích thước, MIME, magic bytes |
| GET | `/files/:id/url` | có quyền với hội thoại chứa tệp | URL ký, hết hạn 5 phút |
| GET | `/files/raw?key&exp&sig` | URL ký | |

## Nhân viên, báo cáo, quản trị
| Phương thức | Đường dẫn | Vai trò |
|---|---|---|
| GET | `/members` | Tất cả |
| POST / PATCH / DELETE | `/members`, `/members/:id` | O (bảo vệ chủ sở hữu cuối cùng) |
| GET | `/reports/summary?from&to&channelId` | O/M/V |
| GET / PATCH | `/workspace` | GET: Tất cả; PATCH: O |
| GET | `/audit-logs?before` | O/M |
| GET | `/ops/webhooks?status`, `/ops/outbound`, `/ops/dead-letter` | O/M |
| POST | `/ops/webhooks/:id/retry` | O/M |
| POST | `/ops/dead-letter/:queue/:id/retry` | O |
| GET | `/policies` | Tất cả |
| POST | `/policies`, `/policies/:id/deactivate` | O |
| GET | `/export/conversations.csv`, `/export/messages.csv?conversationId` | O/M |
| POST | `/demo/inbound`, `/demo/fail-next-send` | O/M/A, chỉ workspace demo |
| GET | `/health` | công khai |

## WebSocket (socket.io, đường dẫn `/socket.io`)
Xác thực bằng cookie phiên. Client gửi `join {workspaceId}` → máy chủ chỉ cho vào phòng các kênh được cấp (và phòng quản lý với O/M).
Sự kiện máy chủ phát: `message.created`, `message.updated`, `note.created`, `conversation.updated`, `conversation.assigned`, `ai.task`, `agent.typing`, `agent.viewing`, `channel.updated`.
Client gửi: `viewing {conversationId}`, `typing {conversationId}` (kiểm tra quyền với hội thoại).
