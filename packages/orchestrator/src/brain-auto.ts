import { CATALOG } from "@dotaka/agents";
import { activeDna, bus, byId, emit, q, type Row } from "@dotaka/db";
import { effectiveProvider, generate } from "@dotaka/llm-gateway";
import { logger, nowIso } from "@dotaka/shared";
import { z } from "zod";
import {
  activeVault, createVault, freePath, noteExists, parseFrontmatter, readNoteFile, safeName, scanVault, stringifyFrontmatter, upsertAutoBlock, writeNoteFile,
} from "./brain.ts";
import { notifyDesktop } from "./creative.ts";

/**
 * Bộ não tự vận hành: the system writes its own memory into the vault —
 * daily / weekly / monthly logs, a live Dashboard, one note per agent, a wiki note per skill, product & knowledge
 * notes, the brand DNA, every finished piece of agent work, videos, conversations with Ngân Nguyệt, lessons,
 * and reminders that fire on time. Generated text lives between `taki:auto` markers, so the CEO's own writing
 * in the same note is never overwritten.
 */
const TZ = "Asia/Ho_Chi_Minh";
export const vnDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const vnTime = (iso: string) => new Date(iso).toLocaleTimeString("vi-VN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayStart = (date: string) => new Date(`${date}T00:00:00+07:00`);
const addDays = (date: string, n: number) => vnDate(new Date(dayStart(date).getTime() + n * 86400_000 + 3600_000));
const vnDow = (date: string) => new Date(`${date}T12:00:00+07:00`).getUTCDay(); // 0 = Chủ nhật
export function isoWeek(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
const weekStart = (date: string) => addDays(date, -((vnDow(date) + 6) % 7)); // Monday
const viDate = (date: string) => date.split("-").reverse().join("/");
const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;
const agentLabel = (key: string) => CATALOG.find((c) => c.key === key)?.label ?? key;
const agentLink = (key: string) => `[[${agentLabel(key)}]]`;

/** JSON agent output → readable Markdown. */
export function toMd(v: unknown, depth = 0): string {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) {
    return v.map((x) => (x && typeof x === "object" ? `- ${Object.entries(x).map(([k, y]) => `**${k}**: ${typeof y === "object" ? JSON.stringify(y) : y}`).join(" · ")}` : `- ${x}`)).join("\n");
  }
  return Object.entries(v as Row).filter(([, x]) => x != null && x !== "" && !(Array.isArray(x) && !x.length)).map(([k, x]) => {
    const head = depth === 0 ? `## ${k}` : `**${k}**`;
    return x && typeof x === "object" ? `${head}\n${toMd(x, depth + 1)}` : `${head}: ${x}`;
  }).join("\n\n");
}

function vaultFor(bizId: string): Row | null {
  try { return activeVault(bizId); } catch { return null; }
}
/** Note created once (by an id in its frontmatter), later only its auto block is refreshed. */
function upsertById(v: Row, idKey: string, id: string, folder: string, title: string, meta: Row, block: string) {
  const found = q.get<Row>(`SELECT path FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.${idKey}') = ?`, v.id, id);
  const rel = found?.path ?? freePath(v, folder, title);
  return upsertAutoBlock(v, rel, block, () => `${stringifyFrontmatter({ ...meta, [idKey]: id })}# ${title}\n`);
}

// ---------------- Default vault ----------------
export function ensureDefaultVault(bizId: string) {
  if (q.get("SELECT id FROM brain_vault WHERE biz_id = ?", bizId)) return;
  const biz = byId<Row>("biz", bizId);
  createVault(bizId, { name: `Bộ não ${biz?.name ?? "TAKI"}` }, "system");
}

// ---------------- Identity, knowledge, skills, agents, lessons ----------------
function syncDna(v: Row) {
  const dna = activeDna(v.biz_id);
  if (!dna) return;
  const d = dna.data as any;
  const products = (d.products ?? []) as Row[];
  for (const p of products) {
    upsertById(v, "product_key", p.key, "05 - Knowledge/Sản phẩm", p.name, { type: "fact", tags: ["sản-phẩm"] }, [
      `**Sản phẩm:** ${p.name}${p.aliases?.length ? ` (còn gọi: ${p.aliases.join(", ")})` : ""}`,
      `**Hình thức:** ${p.format ?? "—"} · **Giá:** ${p.price == null ? "liên hệ" : p.price === 0 ? "miễn phí" : vnd(p.price)}`,
      p.audience ? `**Dành cho:** ${p.audience}` : "", p.link ? `**Link:** ${p.link}` : "",
      "", p.summary ?? "", "", `Thuộc [[DNA thương hiệu]] · ${d.company?.brand ?? ""}`,
    ].filter((x) => x !== undefined).join("\n"));
  }
  upsertById(v, "dna", "active", "02 - Identity", "DNA thương hiệu", { type: "identity" }, [
    `_Phiên bản DNA ${dna.version} · tự đồng bộ từ "Mục tiêu & DNA" — sửa DNA trong hệ thống, ghi chú này tự cập nhật._`, "",
    toMd({
      "Doanh nghiệp": d.company, "Định vị": d.positioning, "Sứ mệnh": d.mission, "Khách hàng mục tiêu": d.audience, "Ưu đãi": d.offers,
      "Khác biệt": d.differentiators, "Giọng thương hiệu": d.voice, "Claim bị cấm": d.forbiddenClaims, "Kênh": d.channels, "Mục tiêu": d.goals, "Cần xác nhận": d.pendingConfirmations,
    }),
    "", "## Sản phẩm", ...products.map((p) => `- [[${safeName(p.name)}]]`),
  ].join("\n"));
}
function syncKnowledgeDocs(v: Row) {
  for (const d of q.all<Row>("SELECT * FROM knowledge_doc WHERE biz_id = ? AND source NOT LIKE 'brain:%'", v.biz_id)) {
    const found = q.get<Row>("SELECT path, mtime FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.source') = ?", v.id, `knowledge_doc:${d.id}`);
    if (found && found.mtime >= d.updated_at) continue;
    const rel = found?.path ?? freePath(v, "05 - Knowledge", d.title);
    writeNoteFile(v, rel, `${stringifyFrontmatter({ type: "fact", kind: d.kind, source: `knowledge_doc:${d.id}`, tags: d.tags })}# ${d.title}\n\n_Từ Kho tri thức (${d.source}). Sửa trong trang Kho tri thức để agent dùng bản mới._\n\n${d.body}\n`);
  }
}
function syncSkills(v: Row) {
  const users = new Map<string, string[]>();
  for (const a of q.all<Row>("SELECT agent_key, skill_key FROM agent_skill WHERE biz_id = ? AND enabled = 1", v.biz_id)) users.set(a.skill_key, [...(users.get(a.skill_key) ?? []), a.agent_key]);
  for (const s of q.all<Row>("SELECT key, kind, name, description, body, grp, version, hash FROM skill WHERE biz_id = ? AND status = 'active'", v.biz_id)) {
    const found = q.get<Row>("SELECT path, meta FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.skill') = ?", v.id, s.key);
    if (found?.meta?.hash === s.hash) continue;
    const rel = found?.path ?? freePath(v, `10 - Wiki/Skills${s.grp ? `/${safeName(s.grp)}` : ""}`, s.name);
    const body = String(s.body).replace(/^---[\s\S]*?---\n?/, "");
    writeNoteFile(v, rel, `${stringifyFrontmatter({ type: "skill", skill: s.key, kind: s.kind, group: s.grp, version: s.version, hash: s.hash })}# ${s.name}\n\n> ${String(s.description).replace(/\n/g, " ").slice(0, 600)}\n\n**Nhóm:** ${s.grp ?? "—"} · **Phiên bản:** ${s.version}\n**Agent dùng:** ${(users.get(s.key) ?? []).map(agentLink).join(", ") || "—"}\n\n---\n\n${body}\n`);
  }
}
function syncAgents(v: Row) {
  const skills = new Map(q.all<Row>("SELECT key, name FROM skill WHERE biz_id = ?", v.biz_id).map((s) => [s.key, s.name]));
  for (const c of CATALOG) {
    const cfg = q.get<Row>("SELECT enabled, autonomy, limits FROM agent_config WHERE biz_id = ? AND agent_key = ?", v.biz_id, c.key);
    const st = q.get<Row>("SELECT COUNT(*) n, SUM(status = 'done') ok, SUM(status IN ('failed','blocked')) bad FROM task WHERE biz_id = ? AND agent_key = ?", v.biz_id, c.key);
    const mine = q.all<Row>("SELECT skill_key FROM agent_skill WHERE biz_id = ? AND agent_key = ? AND enabled = 1 ORDER BY priority", v.biz_id, c.key);
    const recent = q.all<Row>("SELECT path, title FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.agent') = ? AND json_extract(meta, '$.type') != 'agent' ORDER BY mtime DESC LIMIT 8", v.id, c.key);
    // Own id key: `agent:` is also on every note an agent produced (would match those instead).
    upsertById(v, "agent_profile", c.key, "agents", c.label, { type: "agent" }, [
      `**Vai trò:** ${c.description}`,
      `**Khâu:** ${c.stage === 0 ? "Tổng điều phối" : c.stage} · **Trạng thái:** ${cfg?.enabled ? "đang bật" : "đang tắt"} · **Tự chủ:** ${cfg?.autonomy ?? c.autonomy} · **Model:** ${cfg?.limits?.model ?? `theo tầng ${c.tier}`}`,
      `**Công cụ:** ${c.tools.join(", ")}`,
      `**Tác vụ:** ${st?.n ?? 0} (xong ${st?.ok ?? 0}, lỗi/chặn ${st?.bad ?? 0})`, "",
      "## Skill đang dùng", mine.length ? mine.map((m) => `- [[${safeName(skills.get(m.skill_key) ?? m.skill_key)}]]`).join("\n") : "—", "",
      "## Việc gần đây", recent.length ? recent.map((r) => `- [[${r.path.replace(/\.md$/, "")}|${r.title}]]`).join("\n") : "—", "",
      c.key === "assistant" ? "Điều phối tất cả: " + CATALOG.filter((x) => x.key !== "assistant").map((x) => agentLink(x.key)).join(" · ") : "Điều phối bởi [[Ngân Nguyệt]]",
    ].join("\n"));
  }
}
function syncLessons(v: Row) {
  for (const l of q.all<Row>("SELECT * FROM lesson WHERE biz_id = ?", v.biz_id)) {
    if (q.get("SELECT 1 FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.lesson_id') = ?", v.id, l.id)) continue;
    upsertById(v, "lesson_id", l.id, "07 - Learning/Bài học", String(l.statement).slice(0, 80), { type: "lesson", agent: l.agent_key ?? undefined, status: l.status }, [
      `**Bài học:** ${l.statement}`, l.applies_when ? `**Áp dụng khi:** ${JSON.stringify(l.applies_when)}` : "", `**Bằng chứng:** ${typeof l.evidence === "string" ? l.evidence : JSON.stringify(l.evidence)}`,
      l.agent_key ? `**Agent:** ${agentLink(l.agent_key)}` : "", `Rút ra ngày [[${vnDate(new Date(l.created_at))}]]`,
    ].filter(Boolean).join("\n"));
  }
}

function syncFeedback(v: Row) {
  const rows = q.all<Row>("SELECT m.text, m.feedback, m.feedback_note, m.updated_at, t.title FROM assistant_message m JOIN assistant_thread t ON t.id = m.thread_id WHERE m.biz_id = ? AND m.feedback IS NOT NULL ORDER BY m.updated_at DESC LIMIT 200", v.biz_id);
  if (!rows.length) return;
  upsertAutoBlock(v, "07 - Learning/Phản hồi cho Ngân Nguyệt.md", [
    `Sếp chấm ${rows.length} câu trả lời của [[Ngân Nguyệt]] · 👍 ${rows.filter((r) => r.feedback === "up").length} · 👎 ${rows.filter((r) => r.feedback === "down").length}. Góp ý có ghi chú được Ngân Nguyệt áp dụng ngay từ tin nhắn sau.`, "",
    ...rows.map((r) => `- ${r.feedback === "up" ? "👍" : "👎"} ${viDate(vnDate(new Date(r.updated_at)))} · _${r.title}_${r.feedback_note ? ` — **${r.feedback_note}**` : ""}\n  > ${String(r.text).replace(/\s+/g, " ").slice(0, 160)}…`),
  ].join("\n"), () => `${stringifyFrontmatter({ type: "lesson", agent: "assistant" })}# Phản hồi cho Ngân Nguyệt\n`);
}

// ---------------- Work archive (event hooks) ----------------
export function archiveTask(taskId: string) {
  const t = byId<Row>("task", taskId);
  if (!t || t.status !== "done") return;
  const v = vaultFor(t.biz_id);
  if (!v) return;
  const date = vnDate(new Date(t.updated_at));
  const goal = t.goal_id ? byId<Row>("goal", t.goal_id) : null;
  const ci = q.get<Row>("SELECT * FROM content_item WHERE task_id = ?", t.id);
  const review = ci?.review_score_id ? byId<Row>("review_score", ci.review_score_id) : null;
  const meta = { type: "content", agent: t.agent_key, date, status: ci?.status ?? t.status, channel: ci?.channel ?? undefined };
  const links = `${agentLink(t.agent_key)} · [[${date}]]${goal ? ` · [[${safeName(goal.title)}]]` : ""}`;
  if (["content", "video_script", "seo_web"].includes(t.agent_key)) {
    upsertById(v, "task_id", t.id, "04 - Marketing Engine/Nội dung", `${date} ${t.title}`, meta, [
      links, review ? `**Điểm review:** ${review.total} (${review.verdict})` : null, `**Kênh:** ${ci?.channel ?? "—"} · **Trạng thái:** ${ci?.status ?? t.status}`, "",
      ci?.body ?? toMd(t.output),
    ].filter((x) => x != null).join("\n"));
  } else if (t.agent_key === "ads") {
    upsertById(v, "task_id", t.id, "04 - Marketing Engine/Quảng cáo", `${date} ${t.title}`, { ...meta, type: "report" }, `${links}\n\n${toMd(t.output)}`);
  } else if (goal) {
    upsertById(v, "task_id", t.id, `03 - Work/${safeName(goal.title)}`, `${agentLabel(t.agent_key)} — ${goal.title}`, { ...meta, type: "project" }, `${links}\n\n${toMd(t.output)}`);
  } else {
    upsertById(v, "task_id", t.id, "03 - Work/Việc lẻ", `${date} ${t.title}`, { ...meta, type: "project" }, `${links}\n\n${toMd(t.output)}`);
  }
  if (goal) syncGoal(v, goal.id);
}
function syncGoal(v: Row, goalId: string) {
  const g = byId<Row>("goal", goalId);
  if (!g) return;
  const tasks = q.all<Row>("SELECT id, agent_key, title, status FROM task WHERE goal_id = ? ORDER BY created_at", g.id);
  const notes = new Map(q.all<Row>("SELECT path, json_extract(meta, '$.task_id') tid FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.task_id') IS NOT NULL", v.id).map((r) => [r.tid, r.path]));
  upsertById(v, "goal_id", g.id, `03 - Work/${safeName(g.title)}`, g.title, { type: "project", status: g.status }, [
    `**Mục tiêu:** ${g.description}`, `**Loại:** ${g.template} · **Ngân sách ads:** ${vnd(g.budget_ads ?? 0)} · **Hạn:** ${g.due_date ?? "—"} · **Trạng thái:** ${g.status}`, "",
    "## Tác vụ", ...tasks.map((t) => `- [${t.status === "done" ? "x" : " "}] ${notes.get(t.id) ? `[[${notes.get(t.id).replace(/\.md$/, "")}|${t.title}]]` : t.title} — ${agentLink(t.agent_key)} · ${t.status}`),
  ].join("\n"));
}
export function archiveVideo(jobId: string) {
  const j = byId<Row>("creative_job", jobId);
  if (!j || j.status !== "done") return;
  const v = vaultFor(j.biz_id);
  if (!v) return;
  const date = vnDate(new Date(j.ended_at ?? j.updated_at));
  const a = j.asset_id ? byId<Row>("creative_asset", j.asset_id) : null;
  const r = (j.result ?? {}) as Row;
  upsertById(v, "creative_job", j.id, "04 - Marketing Engine/Video", `${date} ${j.title}`, { type: "video", agent: "creative", date, tool: j.tool }, [
    `${agentLink("creative")} · [[${date}]] · công cụ Flow: ${j.tool}`,
    a ? `**File:** \`${a.path}\` · ${Number(a.duration ?? 0).toFixed(1)}s · ${a.width}x${a.height}` : "", "",
    r.caption ? `## Caption\n${r.caption}` : "",
    r.script?.length ? `## Lời thoại\n${(r.script as Row[]).map((s) => `${s.canh}. ${s.loi_thoai}`).join("\n")}` : "",
    r.notes ? `## Ghi chú sản xuất\n${r.notes}` : "",
  ].filter(Boolean).join("\n"));
}
export function archiveConversation(threadId: string) {
  const t = byId<Row>("assistant_thread", threadId);
  if (!t) return;
  const v = vaultFor(t.biz_id);
  if (!v) return;
  const msgs = q.all<Row>("SELECT role, text, created_at FROM assistant_message WHERE thread_id = ? ORDER BY created_at", t.id);
  if (!msgs.length) return;
  const date = vnDate(new Date(t.created_at));
  const acts = q.all<Row>("SELECT title, status FROM assistant_action WHERE thread_id = ?", t.id);
  const disp = q.all<Row>("SELECT title, kind FROM assistant_dispatch WHERE thread_id = ?", t.id);
  upsertById(v, "thread_id", t.id, "08 - Thinking/Hội thoại", `${date} ${t.title}`, { type: "conversation", agent: "assistant", date }, [
    `Trò chuyện với [[Ngân Nguyệt]] · [[${date}]]`,
    disp.length ? `\n**Việc đã giao:** ${disp.map((d) => `${d.title} (${d.kind})`).join("; ")}` : "",
    acts.length ? `**Thẻ xác nhận:** ${acts.map((a) => `${a.title} → ${a.status}`).join("; ")}` : "", "",
    ...msgs.map((m) => `### ${m.role === "user" ? "Sếp" : "Ngân Nguyệt"} · ${vnTime(m.created_at)}\n${m.text}`),
  ].filter((x) => x !== undefined).join("\n"));
}

// ---------------- Logs ----------------
function dayStats(bizId: string, date: string) {
  const from = dayStart(date).toISOString(), to = dayStart(addDays(date, 1)).toISOString();
  const between = "BETWEEN ? AND ?";
  const tasks = q.all<Row>(`SELECT agent_key, status, COUNT(*) n FROM task WHERE biz_id = ? AND updated_at ${between} GROUP BY agent_key, status`, bizId, from, to);
  const content = q.all<Row>(`SELECT status, COUNT(*) n FROM content_item WHERE biz_id = ? AND created_at ${between} GROUP BY status`, bizId, from, to);
  const approvals = q.all<Row>(`SELECT status, COUNT(*) n FROM approval WHERE biz_id = ? AND decided_at ${between} GROUP BY status`, bizId, from, to);
  const pending = q.scalar<number>("SELECT COUNT(*) FROM approval WHERE biz_id = ? AND status = 'pending'", bizId) ?? 0;
  const videos = q.all<Row>(`SELECT title, status FROM creative_job WHERE biz_id = ? AND updated_at ${between}`, bizId, from, to);
  let spend = 0, results = 0, clicks = 0;
  for (const m of q.all<Row>("SELECT metrics FROM metric_snapshot WHERE biz_id = ? AND entity_type = 'ad' AND day = ?", bizId, date)) { spend += Number(m.metrics?.spend ?? 0); results += Number(m.metrics?.results ?? 0); clicks += Number(m.metrics?.clicks ?? 0); }
  const convs = q.scalar<number>(`SELECT COUNT(*) FROM conversation WHERE biz_id = ? AND created_at ${between}`, bizId, from, to) ?? 0;
  const leads = q.all<Row>(`SELECT grade, COUNT(*) n FROM lead WHERE biz_id = ? AND created_at ${between} GROUP BY grade`, bizId, from, to);
  const orders = q.get<Row>(`SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM orders WHERE biz_id = ? AND created_at ${between}`, bizId, from, to);
  const threads = q.all<Row>(`SELECT id, title FROM assistant_thread WHERE biz_id = ? AND last_message_at ${between}`, bizId, from, to);
  const dispatches = q.all<Row>(`SELECT title, kind FROM assistant_dispatch WHERE biz_id = ? AND created_at ${between}`, bizId, from, to);
  return { tasks, content, approvals, pending, videos, spend, results, clicks, convs, leads, orders, threads, dispatches };
}
function statsMd(s: ReturnType<typeof dayStats>) {
  const byAgent = new Map<string, Row>();
  for (const t of s.tasks) { const a = byAgent.get(t.agent_key) ?? {}; a[t.status] = t.n; byAgent.set(t.agent_key, a); }
  const sum = (rows: Row[], st?: string) => rows.filter((r) => !st || r.status === st).reduce((a, r) => a + Number(r.n), 0);
  return [
    "## Các agent đã làm",
    byAgent.size ? [...byAgent.entries()].map(([k, a]) => `- ${agentLink(k)}: ${Object.entries(a).map(([st, n]) => `${st} ${n}`).join(", ")}`).join("\n") : "- Không có tác vụ nào.",
    "", "## Nội dung & duyệt",
    `- Nội dung mới: **${sum(s.content)}** · Đã quyết duyệt: **${sum(s.approvals)}** (duyệt ${sum(s.approvals, "approved")}, từ chối ${sum(s.approvals, "rejected")}) · Đang chờ duyệt: **${s.pending}**`,
    s.videos.length ? `- Video Flow: ${s.videos.map((x) => `${x.title} (${x.status})`).join("; ")}` : null,
    "", "## Quảng cáo & khách hàng",
    `- Chi tiêu ads: **${vnd(s.spend)}** · Kết quả: **${s.results}** · Click: ${s.clicks}${s.results ? ` · CPA ${vnd(s.spend / s.results)}` : ""}`,
    `- Hội thoại mới: **${s.convs}** · Lead: ${s.leads.map((l) => `${l.grade} ${l.n}`).join(", ") || "0"} · Đơn: **${s.orders?.n ?? 0}** (${vnd(s.orders?.s ?? 0)})`,
    "", "## Ngân Nguyệt",
    s.dispatches.length ? s.dispatches.map((d) => `- Đã giao: ${d.title} (${d.kind})`).join("\n") : "- Chưa giao việc nào.",
    s.threads.length ? `- Hội thoại: ${s.threads.map((t) => t.title).join("; ")}` : null,
  ].filter((x) => x != null).join("\n");
}
export function writeDaily(bizId: string, date = vnDate()) {
  const v = vaultFor(bizId);
  if (!v) return null;
  const rel = `01 - Daily Log/${date}.md`;
  const created = q.all<Row>("SELECT path, title FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.date') = ? AND path != ?", v.id, date, rel);
  const due = q.all<Row>("SELECT path, title FROM brain_note WHERE vault_id = ? AND json_extract(meta, '$.type') = 'reminder' AND substr(json_extract(meta, '$.due'), 1, 10) = ?", v.id, date);
  const block = [
    `← [[${addDays(date, -1)}]] · [[${isoWeek(date)}]] · [[${addDays(date, 1)}]] →`, "",
    statsMd(dayStats(bizId, date)),
    due.length ? `\n## Nhắc việc hôm nay\n${due.map((r) => `- [[${r.path.replace(/\.md$/, "")}|${r.title}]]`).join("\n")}` : "",
    created.length ? `\n## Ghi chú sinh ra trong ngày\n${created.map((r) => `- [[${r.path.replace(/\.md$/, "")}|${r.title}]]`).join("\n")}` : "",
    `\n_Cập nhật tự động lúc ${vnTime(nowIso())}_`,
  ].join("\n");
  return upsertAutoBlock(v, rel, block, () => `${stringifyFrontmatter({ type: "daily", date })}# Nhật ký ${viDate(date)}\n\n## Ghi chú của Sếp\n\n`);
}

const Summary = z.object({ summary: z.string(), highlights: z.array(z.string()), next: z.array(z.string()) });
async function aiSummary(bizId: string, what: string, facts: string) {
  if (effectiveProvider(bizId).provider === "sandbox") return null;
  try {
    const r = await generate({
      bizId, agentKey: "assistant", tier: "small", schema: Summary,
      system: "Bạn là Ngân Nguyệt, trợ lý điều phối. Tóm tắt ngắn gọn, đúng số liệu được cho, tiếng Việt, không bịa.",
      user: `Tóm tắt ${what} cho CEO từ dữ liệu sau (Markdown). Trả JSON: summary (2-4 câu), highlights (3-5 ý), next (2-4 việc nên làm tiếp).\n\n${facts}`,
      sandbox: () => ({ summary: "", highlights: [], next: [] }),
    });
    return r.output;
  } catch (e) { logger.warn("brain.summary_failed", { error: String(e).slice(0, 200) }); return null; }
}
export async function writeWeekly(bizId: string, anyDayOfWeek: string) {
  const v = vaultFor(bizId);
  if (!v) return null;
  const mon = weekStart(anyDayOfWeek);
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const week = isoWeek(mon);
  const facts = days.map((d) => `### ${viDate(d)}\n${statsMd(dayStats(bizId, d))}`).join("\n\n");
  const ai = await aiSummary(bizId, `tuần ${week}`, facts);
  const block = [
    `Tuần ${week}: ${viDate(days[0])} → ${viDate(days[6])} · [[${mon.slice(0, 7)}]]`, "",
    ai ? `## Tóm tắt (Ngân Nguyệt)\n${ai.summary}\n\n**Điểm nổi bật**\n${ai.highlights.map((h) => `- ${h}`).join("\n")}\n\n**Nên làm tiếp**\n${ai.next.map((h) => `- [ ] ${h}`).join("\n")}\n` : "",
    "## Các ngày", ...days.map((d) => `- [[${d}]]`), "", "## Số liệu từng ngày", facts,
  ].join("\n");
  return upsertAutoBlock(v, `02 - Weekly Log/${week}.md`, block, () => `${stringifyFrontmatter({ type: "weekly", week, date: mon })}# Tổng kết tuần ${week}\n\n## Nhận xét của Sếp\n\n`);
}
export async function writeMonthly(bizId: string, month: string) {
  const v = vaultFor(bizId);
  if (!v) return null;
  const first = `${month}-01`;
  const days: string[] = [];
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) days.push(d);
  const weeks = [...new Set(days.map(isoWeek))];
  const s = days.map((d) => dayStats(bizId, d));
  const total = (f: (x: ReturnType<typeof dayStats>) => number) => s.reduce((a, x) => a + f(x), 0);
  const facts = [
    `- Tác vụ agent xong: ${total((x) => x.tasks.filter((t) => t.status === "done").reduce((a, t) => a + Number(t.n), 0))}`,
    `- Nội dung mới: ${total((x) => x.content.reduce((a, t) => a + Number(t.n), 0))}`,
    `- Chi tiêu ads: ${vnd(total((x) => x.spend))} · Kết quả: ${total((x) => x.results)}`,
    `- Hội thoại mới: ${total((x) => x.convs)} · Đơn: ${total((x) => Number(x.orders?.n ?? 0))} (${vnd(total((x) => Number(x.orders?.s ?? 0)))})`,
    `- Video Flow: ${total((x) => x.videos.length)}`,
  ].join("\n");
  const ai = await aiSummary(bizId, `tháng ${month}`, facts);
  const block = [
    `Tháng ${month.split("-").reverse().join("/")}`, "",
    ai ? `## Tóm tắt (Ngân Nguyệt)\n${ai.summary}\n\n**Điểm nổi bật**\n${ai.highlights.map((h) => `- ${h}`).join("\n")}\n\n**Nên làm tiếp**\n${ai.next.map((h) => `- [ ] ${h}`).join("\n")}\n` : "",
    "## Tổng số", facts, "", "## Các tuần", ...weeks.map((w) => `- [[${w}]]`),
  ].join("\n");
  return upsertAutoBlock(v, `03 - Monthly Log/${month}.md`, block, () => `${stringifyFrontmatter({ type: "monthly", month, date: first })}# Tổng kết tháng ${month}\n\n## Nhận xét của Sếp\n\n`);
}

function updateDashboard(v: Row) {
  const b = v.biz_id;
  const today = vnDate();
  const pending = q.all<Row>("SELECT title, created_at FROM approval WHERE biz_id = ? AND status = 'pending' ORDER BY created_at LIMIT 8", b);
  const running = q.all<Row>("SELECT title, agent_key, step FROM task WHERE biz_id = ? AND status IN ('ready','running','in_review','revising') ORDER BY updated_at DESC LIMIT 8", b);
  const bad = q.all<Row>("SELECT title, agent_key, status FROM task WHERE biz_id = ? AND status IN ('failed','blocked') AND updated_at > datetime('now','-3 day') LIMIT 6", b);
  const reminders = upcomingReminders(v, 6);
  const notes = q.scalar<number>("SELECT COUNT(*) FROM brain_note WHERE vault_id = ?", v.id) ?? 0;
  upsertAutoBlock(v, "00 - Dashboard/Dashboard.md", [
    `**Hôm nay:** [[${today}]] · **Tuần này:** [[${isoWeek(today)}]] · **Tháng:** [[${today.slice(0, 7)}]] · ${notes} ghi chú trong bộ não`, "",
    `## Chờ Sếp duyệt (${pending.length})`, pending.length ? pending.map((p) => `- ${p.title}`).join("\n") : "- Không có", "",
    `## Agent đang làm (${running.length})`, running.length ? running.map((t) => `- ${agentLink(t.agent_key)}: ${t.title}${t.step ? ` — _${t.step}_` : ""}`).join("\n") : "- Không có", "",
    bad.length ? `## Cần xử lý\n${bad.map((t) => `- ${agentLink(t.agent_key)}: ${t.title} (${t.status})`).join("\n")}\n` : "",
    "## Nhắc việc sắp tới", reminders.length ? reminders.map((r) => `- ${viDate(String(r.due).slice(0, 10))} ${String(r.due).slice(11, 16)} · [[${r.path.replace(/\.md$/, "")}|${r.title}]]`).join("\n") : "- Không có", "",
    "## Đội AI", CATALOG.map((c) => agentLink(c.key)).join(" · "), "",
    `_Cập nhật lúc ${vnTime(nowIso())}_`,
  ].join("\n"), () => `${stringifyFrontmatter({ type: "dashboard" })}# Dashboard\n`);
}

// ---------------- Reminders (04 - Future Log) ----------------
export function createReminder(bizId: string, p: { title: string; due: string; note?: string; by?: string }) {
  const v = activeVault(bizId);
  // "YYYY-MM-DD HH:mm" without a zone = Vietnam time (the CEO's clock), whatever the server's zone is.
  const raw = p.due.trim();
  const due = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}${raw.length <= 16 ? ":00" : ""}+07:00`);
  if (Number.isNaN(due.getTime())) throw new Error("Thời gian nhắc không hợp lệ");
  const local = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(due).replace(" ", "T");
  const rel = freePath(v, "04 - Future Log", `${local.slice(0, 10)} ${p.title}`);
  writeNoteFile(v, rel, `${stringifyFrontmatter({ type: "reminder", due: `${local}:00+07:00`, done: false, notified: false, by: p.by ?? "Sếp", date: local.slice(0, 10) })}# ${p.title}\n\n${p.note ?? ""}\n\nNhắc lúc ${local.slice(11, 16)} ngày ${viDate(local.slice(0, 10))} · [[${local.slice(0, 10)}]]\n`);
  emit(bizId, "assistant.updated", { reminder: rel });
  return { path: rel, due: `${local}:00+07:00`, title: p.title };
}
export function upcomingReminders(v: Row, limit = 50, includeDone = false) {
  return q.all<Row>(`SELECT path, title, json_extract(meta, '$.due') due, json_extract(meta, '$.done') done, json_extract(meta, '$.notified') notified FROM brain_note
    WHERE vault_id = ? AND json_extract(meta, '$.type') = 'reminder' ${includeDone ? "" : "AND COALESCE(json_extract(meta, '$.done'), 0) = 0"} ORDER BY json_extract(meta, '$.due') LIMIT ?`, v.id, limit);
}
export function setNoteMeta(v: Row, rel: string, patch: Row) {
  const text = readNoteFile(v, rel);
  const { meta, body } = parseFrontmatter(text);
  writeNoteFile(v, rel, `${stringifyFrontmatter({ ...meta, ...patch })}${body}`);
}
function fireReminders(v: Row) {
  const now = Date.now();
  for (const r of upcomingReminders(v, 200)) {
    if (r.notified || !r.due || new Date(r.due).getTime() > now) continue;
    notifyDesktop(`Nhắc việc: ${r.title}`, `Ngân Nguyệt nhắc Sếp — ${String(r.due).slice(11, 16)}`);
    emit(v.biz_id, "alert.raised", { level: "info", text: `⏰ Nhắc việc: ${r.title}` });
    try { setNoteMeta(v, r.path, { notified: true }); } catch (e) { logger.warn("brain.reminder_mark_failed", { error: String(e) }); }
  }
}

// ---------------- Tick + hooks ----------------
let lastSlow = 0;
const running = new Set<string>();
/** Every few minutes: today's log, dashboard, reminders; hourly: agents/skills/knowledge/DNA/lessons; week/month rollups. */
export async function brainTick(bizId: string, opts: { full?: boolean } = {}) {
  if (running.has(bizId)) return;
  running.add(bizId);
  try {
    if (!q.get("SELECT id FROM brain_vault WHERE biz_id = ?", bizId)) { ensureDefaultVault(bizId); opts = { ...opts, full: true }; }
    const v = vaultFor(bizId);
    if (!v) return;
    scanVault(v.id);
    fireReminders(v);
    try { syncFeedback(v); } catch (e) { logger.warn("brain.feedback_sync_failed", { error: String(e) }); }
    if (opts.full || Date.now() - lastSlow > 3600_000) {
      lastSlow = Date.now();
      for (const f of [syncDna, syncKnowledgeDocs, syncSkills, syncLessons, syncAgents]) { try { f(v); } catch (e) { logger.warn("brain.sync_failed", { step: f.name, error: String(e) }); } }
      if (opts.full) {
        for (const t of q.all<Row>("SELECT id FROM task WHERE biz_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 60", bizId)) archiveTask(t.id);
        for (const j of q.all<Row>("SELECT id FROM creative_job WHERE biz_id = ? AND status = 'done'", bizId)) archiveVideo(j.id);
        for (const t of q.all<Row>("SELECT id FROM assistant_thread WHERE biz_id = ?", bizId)) archiveConversation(t.id);
      }
    }
    const today = vnDate();
    writeDaily(bizId, today);
    if (!noteExists(v, `01 - Daily Log/${addDays(today, -1)}.md`) || opts.full) writeDaily(bizId, addDays(today, -1));
    const lastWeekDay = addDays(weekStart(today), -1);
    if (!noteExists(v, `02 - Weekly Log/${isoWeek(lastWeekDay)}.md`)) await writeWeekly(bizId, lastWeekDay);
    const prevMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    if (!noteExists(v, `03 - Monthly Log/${prevMonth}.md`)) await writeMonthly(bizId, prevMonth);
    updateDashboard(v);
  } finally {
    running.delete(bizId);
  }
}

/** Finished work lands in the brain the moment it is done. */
export function registerBrainHooks() {
  const safe = (f: () => void) => setTimeout(() => { try { f(); } catch (e) { logger.warn("brain.hook_failed", { error: String(e).slice(0, 300) }); } }, 500);
  bus.on("task.updated", (p: Row) => { if (p.status === "done" && p.taskId) safe(() => archiveTask(p.taskId)); });
  bus.on("creative.updated", (p: Row) => { if (p.status === "done" && p.jobId) safe(() => archiveVideo(p.jobId)); });
  bus.on("assistant.updated", (p: Row) => { if (p.status === "done" && p.threadId) safe(() => archiveConversation(p.threadId)); });
}
