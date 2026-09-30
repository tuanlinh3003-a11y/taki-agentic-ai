---
name: toiuuquangcao
description: >
  Tự động tạo báo cáo hiệu suất quảng cáo Meta Ads theo tuần từ API trực tiếp.
  Dùng skill này BẤT CỨ KHI NÀO người dùng muốn: tạo báo cáo ads tuần, so sánh
  tuần này vs tuần trước, phân tích CPL/CPM/data theo mã quảng cáo, lập ma trận
  quyết định ngân sách, xem mã nào cần scale/tắt. Kích hoạt khi người dùng nói
  "báo cáo ads tuần", "report tuần", "so sánh tuần", "phân tích mã ads",
  "tổng kết quảng cáo", "/toiuuquangcao", hoặc cung cấp số liệu thô từ Meta Ads.
---

# Tối Ưu Quảng Cáo — Meta Ads Weekly Report

Tự động lấy dữ liệu từ Meta Ads API → tạo báo cáo 7 phần chuẩn → xuất markdown + file nếu cần.

---

## Bước 0 — Thu thập thông tin đầu vào từ user

Trước khi gọi API, hỏi user (nếu chưa có trong context):

1. **Ad Account ID** (dạng `act_XXXXXXXXXX`)
2. **Tuần này**: ngày bắt đầu → kết thúc (VD: `2026-03-07` → `2026-03-14`)
3. **Tuần trước**: ngày bắt đầu → kết thúc (VD: `2026-03-01` → `2026-03-07`)
4. **Ngưỡng CPL hòa vốn** (VD: `40000` VNĐ) — dùng để gắn 🟢🟡🔴
5. **Ngưỡng CPL lý tưởng** (VD: `38000` VNĐ) — dùng làm mốc "tốt/scale"
6. **Ngân sách dự kiến tuần tới** (tùy chọn, dùng cho Phần 5)
7. **Định dạng xuất**: Markdown chat / File Word / Cả hai

---

## Bước 1 — Lấy dữ liệu từ Meta Ads API

Gọi API theo thứ tự sau. Xem chi tiết cú pháp tại `references/api_calls.md`.

### 1.1 — Dữ liệu Campaign level (cả 2 tuần)
```
GET /{account_id}/campaigns
  fields: id, name, status, objective
  date_preset: custom
  time_range: {since, until}
  level: campaign
  metrics: spend, impressions, reach, clicks, inline_link_clicks, actions, cost_per_action_type, cpm, cpc, ctr, inline_link_click_ctr
```

### 1.2 — Dữ liệu Ad Set level (tuần này)
```
GET /{account_id}/adsets
  fields: id, name, status, campaign_id, daily_budget, lifetime_budget
  + insights với metrics như trên
  level: adset
```

### 1.3 — Dữ liệu Ad level (tuần này — đây là "từng mã")
```
GET /{account_id}/ads
  fields: id, name, status, adset_id, campaign_id
  + insights với metrics như trên
  level: ad
```

### 1.4 — Breakdown theo ngày (tuần này)
```
GET /{account_id}/insights
  breakdowns: []
  time_increment: 1  ← từng ngày
  level: account
  metrics: spend, impressions, reach, actions, cpm, ctr
```

> ⚠️ **Lưu ý Breakdown Effect**: Khi tổng hợp kết quả, KHÔNG cộng dồn metrics từ nhiều breakdown khác nhau. Đọc `references/breakdown_effect.md` nếu cần xử lý breakdown theo placement/age/gender.

---

## Bước 2 — Xử lý & chuẩn hóa dữ liệu

### 2.1 — Xác định "data (cd)" = Kết quả chính
- Với mục tiêu **Lead**: `actions` có `action_type = "lead"`
- Với mục tiêu **Message**: `actions` có `action_type = "onsite_conversion.messaging_conversation_started_7d"`
- Với mục tiêu **Purchase**: `actions` có `action_type = "purchase"`
- **CPL** = `spend / số_data`

### 2.2 — Quy tắc gắn màu cho từng mã
Sử dụng ngưỡng user đã nhập ở Bước 0:

| Màu | Điều kiện | Hành động gợi ý |
|---|---|---|
| 🟢 | CPL < ngưỡng lý tưởng | Scale ngân sách 30–50% |
| 🟡 | ngưỡng lý tưởng ≤ CPL ≤ ngưỡng hòa vốn | Theo dõi thêm 2–3 ngày |
| 🔴 | CPL > ngưỡng hòa vốn | Tắt hoặc cải thiện ngay |

### 2.3 — Xử lý null / thiếu data
- Metric trả về `null` → hiển thị `"N/A"`
- Mã chưa có kết quả (data = 0) → CPL = `"N/A"`, gắn ⚪ (chưa đủ data)
- Nếu date range bao gồm hôm nay → thêm chú thích "*Dữ liệu một phần, chưa kết thúc ngày*"

---

## Bước 3 — Tạo báo cáo 7 phần

Chi tiết template từng phần xem tại `references/report_template.md`.

### Phần 1 — Tổng quan so sánh 2 tuần
Bảng so sánh: Tổng chi tiêu / Tổng data / CPL TB / CPL tốt nhất / CPL tệ nhất / Số mã vượt ngưỡng lỗ + nhận định 2–3 câu.

### Phần 2 — Bảng chi tiết từng mã
Bảng sắp xếp CPL thấp → cao: Tên mã / Tài khoản / Trạng thái / Data / CPL / Chi tiêu / CPM / Đánh giá 🟢🟡🔴.

### Phần 3 — 3 Điểm sáng & 3 Điểm tối
Top 3 mã tốt nhất và 3 mã kéo lùi hệ thống — kèm con số cụ thể và chẩn đoán nguyên nhân.

### Phần 4 — Chẩn đoán nguyên nhân gốc rễ
Phân tích 4 chiều: CPM bất thường / Audience saturation / Vấn đề creative / Cấu trúc tài khoản.
Dùng framework phễu: `Impressions → Clicks → Results`
- CPM cao → audience quá hẹp hoặc cạnh tranh lớn
- CTR thấp → creative không hấp dẫn
- CVR thấp → landing page / kịch bản chốt có vấn đề
- Frequency > 3.0 trong 7 ngày → Ad Fatigue, cần thay creative

### Phần 5 — Ma trận quyết định ngân sách
Phân loại mã vào 4 nhóm: 🚀 SCALE / ✅ GIỮ / ⚠️ THEO DÕI / ❌ TẮT NGAY + đề xuất phân bổ ngân sách tuần tới.

### Phần 6 — Kế hoạch hành động 7 ngày
Timeline: Ngày 1–2 (Khẩn cấp) / Ngày 3–5 (Tối ưu) / Ngày 6–7 (Thử nghiệm) + KPI mục tiêu cuối tuần.

### Phần 7 — 2 Prompt AI sẵn sàng dùng
Dựa trên vấn đề cụ thể nhất phát hiện: 1 prompt kỹ thuật/thuật toán + 1 prompt tối ưu creative.

---

## Bước 4 — Xuất kết quả

- **Markdown trong chat**: Luôn làm mặc định
- **File Word (.docx)**: Nếu user yêu cầu → đọc `/mnt/skills/public/docx/SKILL.md` trước khi tạo
- **File PDF**: Nếu user yêu cầu → đọc `/mnt/skills/public/pdf/SKILL.md` trước khi tạo

---

## Nguyên tắc bắt buộc khi phân tích

1. **Chỉ so sánh tuần trước vs tuần này** — không kéo dữ liệu cũ hơn 2 tuần
2. **Mọi nhận định phải kèm con số** — không nói "khá tốt", phải nói "tốt hơn 12%"
3. **Ngưỡng CPL = do user nhập** — không hardcode 40k vào logic
4. **Ưu tiên 1 hành động cao nhất** — nếu chỉ làm 1 việc hôm nay, đó là gì?
5. **Tone thẳng thắn, không tô hồng** — nói thật dù kết quả xấu
6. **Không bịa số** — metric null → hiển thị N/A, không ước tính

---

## References

- `references/api_calls.md` — Cú pháp đầy đủ cho từng API call
- `references/report_template.md` — Template markdown chi tiết từng phần
- `references/breakdown_effect.md` — Cách xử lý Breakdown Effect tránh sai số
