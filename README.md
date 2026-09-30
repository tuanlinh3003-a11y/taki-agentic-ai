# TAKI Agentic AI

Hệ thống AI Agent vận hành marketing & bán hàng cho **TAKI Group / TAKI Academy** theo **Đặc tả kỹ thuật tổng hợp Agentic AI & ads-chat-orchestrator**. Agent chạy bằng **tài khoản Claude (Claude Code CLI)**, theo **DNA TAKI + skill của Phòng Marketing**, với **Jev (TypeSafe System One)** làm lớp phán đoán nhanh.

> Tên thư mục/gói (`dotaka-agentic`, `@dotaka/*`) là tên kỹ thuật từ bản đầu, không ảnh hưởng thương hiệu hiển thị.

## Cài trên máy mới (giữ nguyên giao diện & chức năng)

Yêu cầu: **Node.js 24+** (`.nvmrc`), **Git**, **Claude Code CLI** đã đăng nhập (`claude`). Tuỳ chọn: **PostgreSQL** (để chạy ZL-CRM/Zalo), **Python 3 + ffmpeg** (hậu kỳ video Flow). Đã thử trên macOS; Linux tương tự.

```bash
git clone <địa chỉ repo> taki-agentic-ai
cd taki-agentic-ai
node scripts/bootstrap.mjs      # cài 1 lần: thư viện, .env, skill, công cụ video, ZL-CRM, tự kiểm tra
pnpm dev                        # chạy: http://localhost:5173  (ZL-CRM: http://localhost:5174)
```

Vì sao máy khác chạy **giống hệt** máy gốc:
- **Phiên bản khoá cứng**: `pnpm-lock.yaml` + `pnpm install --frozen-lockfile` (pnpm 12.8.1 khoá trong `packageManager`), ZL-CRM dùng `package-lock.json` + `npm ci`, thư viện Python ghim phiên bản trong `tools/video/requirements*.txt`.
- **Skill Phòng Marketing đóng gói trong repo** (`assets/claude`: 40 skill + DNA + 8 nhân viên). Hệ thống đọc bản này, không phụ thuộc `~/.claude` của từng máy. Sửa skill ở `~/.claude` xong chạy `pnpm skills:export` rồi commit.
- **ZL-CRM đóng gói trong `services/zl-crm`** (kèm bản vá, xem `services/zl-crm/UPSTREAM.md`), tự tạo database và tự nối vào Agentic AI khi `pnpm dev`.
- **Font phụ đề video đóng gói** (`tools/video/fonts`, Be Vietnam Pro) → video xuất ra giống nhau trên mọi máy.
- **CI trên GitHub** (`.github/workflows/ci.yml`) cài lại từ đầu, typecheck, test, build giao diện và chạy thử API mỗi lần đẩy code. `pnpm verify` chạy cùng bộ kiểm tra trên máy.

Không nằm trong repo (sinh riêng cho từng máy, không bao giờ đẩy lên GitHub): `.env` (khoá mã hoá, API key), `data/` (database, video, file tải lên), `services/zl-crm/backend/.env` (mật khẩu ZL-CRM), token Facebook/TikTok/Zalo — kết nối lại trong **Trung tâm tích hợp** sau khi cài.

| Lệnh | Việc làm |
|---|---|
| `pnpm bootstrap` | Cài đặt máy mới (chạy lại an toàn) |
| `pnpm dev` | API (cổng 8787) + giao diện (cổng 5173) + ZL-CRM (3000/5174) |
| `pnpm verify` | Typecheck + test + build giao diện |
| `pnpm skills:export` | Đóng gói lại skill từ `~/.claude` vào repo |
| `pnpm zlcrm:connect` | Nối lại ZL-CRM vào Agentic AI |
| `pnpm seed` | Xóa và tạo lại dữ liệu mẫu |
| `pnpm test` | Test Rule Engine (gồm test "không bao giờ vượt trần ngân sách") và chấm điểm bài |
| `pnpm eval` | Chấm Chat Agent trên bộ tình huống chuẩn (ngưỡng 80%) |
| `pnpm mcp` | MCP Server cho Claude Desktop (cần `MCP_KEY`) |
| `pnpm start` | Build giao diện và chạy một cổng duy nhất 8787 |

## Chế độ chạy — điền `.env` để bật dần

Sao chép `.env.example` → `.env`.

| Thành phần | Không có key | Có key |
|---|---|---|
| **Jev** (`TYPESAFE_API_KEY`) | heuristic cùng định dạng câu trả lời, gắn nhãn "Jev·heuristic" | Jev thật (`jev-latest`) |
| **Claude** | Mặc định dùng **tài khoản Claude đã đăng nhập** qua lệnh `claude` (Claude Code CLI) — không cần API key. Có thể chuyển sang Claude API hoặc sandbox trong Cài đặt | Chọn model theo tầng (mặc định nhỏ `claude-haiku-4-5`, vừa `claude-sonnet-5`, lớn `claude-opus-5`) và riêng từng agent |
| **Meta / TikTok / Google Ads / Pancake / Zalo** | connector sandbox (số liệu mô phỏng) | cần làm connector thật + duyệt ứng dụng từng nền tảng |
| **Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) | ghi log | gửi cảnh báo/báo cáo sáng thật |

Trong sandbox, thời gian được nén: 1 giờ trên nền tảng ≈ 1 phút thật (`TIME_SCALE_SECONDS`).

## Skill Phòng Marketing trong hệ thống

Nguồn: `~/.claude/skills` (skill) và `~/.claude/agents/mkt-*.md` (nhân viên). Trang **Skill & Nhân viên MKT** để xem, bật/tắt, "Đồng bộ lại" (lên phiên bản mới khi skill đổi).

| Nhân viên (persona) | Agent trong hệ thống | Skill nạp kèm |
|---|---|---|
| mkt-nghien-cuu | Research | marketing-research, competitor-alternatives, marketing-psychology |
| mkt-chien-luoc | Brief, Strategy | marketing-plan, digital-plan-dao-tao, chien-luoc-content-doanh-nghiep, content-marketing-planner, kpi-okr-master, mkt-workflow |
| mkt-content | Content | ceo-ai-fb-post, ai-content-planner, social-content, copywriting, humanizer |
| mkt-video | Video | fb-reels-topic-generator, viral-ai-script, hook-3-kenh-ai, phan-tich-video-viral |
| mkt-seo | SEO | ntk-seo-writer, taki-seo-workflow, seo-content-evaluator, seo-blog-workflow |
| mkt-ads | Ads (báo cáo & đề xuất tuần) | facebook-ads-expert, toiuuquangcao, copywriting |
| mkt-phan-tich | Analytics | lead-scoring-system, business-dashboard, fb-post-stats |
| mkt-kiem-duyet | Review (lớp chấm thứ 3) | content-scorer-social, ai-script-scorer, viral-content-scorer, humanizer, remove-ai-marks |
| (bán hàng ABS) | Chat | abs-sales-agent, objection-handler-ai-sales, lead-qualifier-taki |
| (chăm sóc lead) | Follow-up | follow-up-sequence-abs |

Mọi agent gọi Claude đều nhận lớp **DNA** (`taki-dna` + references, hồ sơ `phong-marketing`). Skill viết cho phiên tương tác nên hệ thống giữ phương pháp/tiêu chí, bỏ các bước hỏi lại, ghi file, gọi tool. Mỗi lần chạy ghi lại phiên bản skill đã dùng (`task_run.skills`).

## Sản xuất video Google Flow (Creative Agent)

Trang **Sản xuất video Flow** chạy 3 skill Flow của phòng MKT (`flow-review-do-an-vat`, `flow-cooking-director-video`, `flow-cinematic-short-film`) qua `claude -p --chrome` trên Chrome đã đăng nhập Google Flow:

1. Chọn công cụ + điền thông tin + ảnh → xác nhận (tốn tín dụng Flow, agent dùng Chrome ~35–50 phút, mỗi lần 1 job).
2. Agent vận hành công cụ Flow, tải clip từ `~/Downloads`, soát lời thoại (`taki-video-stt`, faster-whisper), hậu kỳ bằng `taki-video-finish` (ffmpeg + Pillow vì ffmpeg máy không có libass).
3. Hệ thống tự kiểm file (ffprobe), đăng ký video, Review (thương hiệu TAKI: Jev + Kiểm duyệt MKT) → hộp **Duyệt**.
4. Duyệt → đăng **bản nháp** lên kênh đã chọn (hiện connector sandbox; bản thật: TikTok inbox draft, Facebook video chưa công khai).

Quyền của agent chỉ gồm công cụ Chrome, đọc/ghi file trong thư mục job + Downloads, và các lệnh `ffmpeg`, `ffprobe`, `taki-video-finish`, `taki-video-stt`, `cp/mv/ls/mkdir/unzip/curl`. Kênh "khác/khách hàng" không nạp DNA TAKI.

## Jev làm gì trong hệ thống

Jev trả lời câu hỏi có kiểu (Có/Không, Chọn một, Chấm điểm) kèm xác suất. **Code giữ chính sách**: ngưỡng → hành động nằm trong `packages/jev/src/questions.ts` (`decideChat`, `decideGuard`…).

| Chỗ dùng | Câu hỏi Jev | Code quyết định |
|---|---|---|
| Mỗi tin nhắn khách (1 request, 9 câu) | ý định, nhiệt độ lead, đòi gặp người, khiếu nại, mặc cả, chèn lệnh, opt-out, nguồn biết đến, sản phẩm | chuyển sales khi lead nóng, chuyển người khi khiếu nại/mặc cả, trả lời an toàn khi chèn lệnh, ngừng nhắn khi opt-out, ghi attribution |
| RAG | độ hữu ích từng đoạn tri thức + đủ thông tin chưa | chỉ đoạn đủ tốt mới tới Claude; thiếu thì chuyển người, không đoán |
| Guardrail trước khi gửi | cam kết kết quả, dữ kiện không có nguồn, lộ nội bộ, trả lời đúng câu hỏi, giọng điệu | chặn và chuyển người (sau lớp kiểm giá tất định) |
| Review Agent | đúng chân dung CEO/SME, hook, giá trị cụ thể, giọng, CTA, hứa hẹn tài chính, rủi ro chính sách QC | pass / sửa / chặn / escalate theo rubric có phiên bản |
| Quét bài | phân loại bình luận, độ khớp bài–mục tiêu | thành phần `intent` và `fit` của điểm bài → đề xuất chạy ads |
| Feedback loop | phân loại lý do CEO từ chối | gom thành bài học / đề xuất thay đổi |

Nhật ký mọi phán đoán (câu trả lời, xác suất, quyết định, độ trễ, chi phí) ở trang **Jev · System One**.

## Kiến trúc (theo đặc tả)

```
apps/api          REST /v1 + SSE realtime + webhook có chữ ký (/hooks/:platform)
apps/web          Giao diện CEO (13 màn hình)
apps/mcp-server   MCP Server (key có quyền, xem trước + xác nhận cho lệnh ghi)
packages/contracts   Zod schema: hợp đồng giữa các agent
packages/jev         Lớp phán đoán Jev + heuristic dự phòng + nhật ký
packages/llm-gateway Nơi DUY NHẤT gọi Claude: Claude CLI (tài khoản) / API / sandbox, model theo tầng & theo agent, trần token, chi phí
packages/orchestrator Hàng đợi, scheduler, máy trạng thái task, Agent Runtime, Review, ads, đăng bài, học
packages/rule-engine  Rule tất định: minData, cooldown, budgetGuard, dry-run (có test thuộc tính)
packages/scoring      Điểm bài tất định, lý do sinh từ số liệu
packages/chat-engine  Máy trạng thái hội thoại, RAG, guardrail, chuyển người, follow-up
packages/connectors   Interface chung + connector sandbox + Telegram + chữ ký webhook
packages/agents       Định nghĩa agent, prompt, danh mục & mức tự chủ mặc định
packages/db           Schema (mọi bảng có biz_id), outbox, audit log
evals/                Bộ tình huống chuẩn + runner
```

## Khác biệt so với đặc tả (có chủ đích, để chạy được ngay trên máy)

- **CSDL**: SQLite tích hợp trong Node thay PostgreSQL + pgvector; schema giữ nguyên tên bảng/cột để chuyển sang Postgres. RAG đang dùng tìm kiếm từ khóa + Jev chấm lại thay cho vector.
- **Hàng đợi**: lưu trong DB (retry lũy thừa, idempotency, khóa theo đối tượng, dead-letter) thay Redis/BullMQ; cùng interface `enqueue/startWorkers`.
- **Đăng nhập**: chưa có (M0). Server chỉ nghe `127.0.0.1`. Không mở ra Internet trước khi có đăng nhập + 2FA.
- **Connector nền tảng**: sandbox. Connector thật cần duyệt ứng dụng Meta/TikTok/Google/Zalo — nên nộp hồ sơ ngay.

## Việc cần Sếp làm

1. Chốt các mục ⚠️ trong DNA (định vị, bộ số công bố, giá các khóa đang "liên hệ", Autovis/Remin/Diaflow, đối thủ). Sửa trong skill `taki-dna` rồi bấm Đồng bộ, hoặc sửa trực tiếp ở **Mục tiêu & DNA**.
2. Vào **Kho tri thức** → thêm lịch khai giảng thật (bot không tự đưa ngày khi chưa có).
3. Giữ máy đăng nhập Claude Code (`claude` → `/login`). Chọn model trong **Cài đặt → Model Claude** hoặc từng agent ở **Agent & Tác vụ**.
4. Chuẩn bị tài khoản & quyền API: Meta Business, TikTok for Business, Google Ads developer token, Pancake, Zalo OA.

## ZL-CRM (Zalo nhiều nick) chạy kèm trên local

- Mã nguồn: `services/zl-crm` (clone từ github.com/nguyentatkiem/ZL-CRM, nhánh `feat/public-api-conversation-account`).
- `pnpm dev` tự chạy thêm ZL-CRM: backend http://localhost:3000, giao diện http://localhost:5174 (log ở `services/zl-crm/data/`).
- Không cần Docker: dùng PostgreSQL local (database `zalocrm`, user `zlcrm`), Redis ở chế độ in-memory. Chưa cài MinIO nên gửi/nhận **ảnh/video** trong ZL-CRM chưa hoạt động; tin chữ hoạt động bình thường.
- Cấu hình + tài khoản quản trị ZL-CRM: `services/zl-crm/backend/.env` (`BOOTSTRAP_ADMIN_PHONE` / `BOOTSTRAP_ADMIN_PASSWORD`, đổi mật khẩu sau khi đăng nhập).
- Khi đổi schema ZL-CRM: `cd services/zl-crm/backend && npx prisma db push`.
- Agentic AI nối ZL-CRM qua Public API key (Trung tâm tích hợp › ZL-CRM) → trang **Follow-up Zalo**.
