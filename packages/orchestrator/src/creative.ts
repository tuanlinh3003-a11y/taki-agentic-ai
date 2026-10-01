import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { FLOW_URL, listChromeProfiles, openInProfile } from "./chrome-profiles.ts";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { activeDna, audit, bizSettings, byId, emit, insert, q, update, type Row } from "@dotaka/db";
import { connector, platformForChannel } from "@dotaka/connectors";
import { effectiveProvider, modelFor, runClaudeAgent, runClaudeInTerminal } from "@dotaka/llm-gateway";
import { agentPlaybook } from "@dotaka/skills";
import { AppError, logger, nowIso } from "@dotaka/shared";
import { PermanentError, enqueue } from "./queue.ts";
import { reviewOutput } from "./review.ts";

/**
 * Creative Agent: produces finished videos on Google Flow by running the Marketing department's Flow skills
 * through Claude Code in the CEO's own Chrome (Claude in Chrome), then post-produces locally (ffmpeg +
 * taki-video-finish), registers the asset, reviews it, and after approval uploads it to channels as a DRAFT.
 * Each run consumes Flow credits and drives the user's browser, so jobs are started explicitly and run
 * one at a time (lock "flow-chrome").
 */
export const FLOW_TOOLS = {
  "review-do-an-vat": { skill: "flow-review-do-an-vat", label: "Review Đồ Ăn Vặt AI V6", minutes: 35, hint: "Tên sản phẩm, ảnh sản phẩm (tuỳ chọn), giọng, ưu đãi/CTA" },
  "cooking-director": { skill: "flow-cooking-director-video", label: "Flow Cooking Director v2", minutes: 45, hint: "3 ảnh (chân dung người dẫn, món ăn, bao bì/góc bếp) + tên, giá, điểm nổi bật" },
  "cinematic": { skill: "flow-cinematic-short-film", label: "Cinematic Short Film Studio", minutes: 50, hint: "Ảnh nhân vật/bối cảnh/đạo cụ + chủ đề, thông điệp, thời lượng 30/60/90s" },
} as const;
export type FlowToolKey = keyof typeof FLOW_TOOLS;

export const CreativeInput = z.object({
  tool: z.enum(Object.keys(FLOW_TOOLS) as [FlowToolKey, ...FlowToolKey[]]),
  title: z.string().min(2).max(120),
  brief: z.string().min(5).max(6000), // product info / topic / script
  product: z.string().max(200).optional(),
  durationSec: z.number().int().min(15).max(120).optional(),
  voice: z.string().max(200).optional(),
  hookTitle: z.string().max(120).optional(),
  cta: z.string().max(160).optional(),
  images: z.array(z.object({ path: z.string(), role: z.string() })).max(5).default([]),
  channels: z.array(z.string()).min(1).default(["tiktok"]),
  brand: z.enum(["taki", "other"]).default("other"), // "other" = affiliate/client channel: TAKI DNA is NOT applied
  sourceContentId: z.string().optional(),
});
export type CreativeInput = z.infer<typeof CreativeInput>;

const FlowResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  finalPath: z.string(),
  durationSec: z.number(),
  scenes: z.number(),
  redoneScenes: z.array(z.object({ scene: z.number(), reason: z.string() })),
  script: z.array(z.object({ canh: z.number(), loi_thoai: z.string() })),
  caption: z.string(),
  notes: z.string(),
});

export const DATA_DIR = resolve(process.cwd(), "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
const DOWNLOADS = join(homedir(), "Downloads");

export function flowSettings(bizId: string) {
  return {
    browserDeviceId: null as string | null, browserLabel: null as string | null, timeoutMin: 75,
    // Chrome profile chosen by the CEO (the one logged into Flow). Preferred over a bare deviceId.
    chromeChannel: null as string | null, chromeProfileDir: null as string | null, chromeProfileName: null as string | null, chromeProfileEmail: null as string | null,
    ...((bizSettings(bizId) as any).flow ?? {}),
  };
}

/** Prompt lines telling the Flow agent how to land on the right Chrome profile (inside the supervised session). */
function browserInstructions(fs: ReturnType<typeof flowSettings>) {
  const who = fs.chromeProfileEmail ? `email ${fs.chromeProfileEmail}` : `profile "${fs.chromeProfileName}"`;
  return [
    `- Trình duyệt: Claude in Chrome, ĐÚNG profile Chrome "${fs.chromeProfileName ?? fs.browserLabel ?? "đã chọn"}"${fs.chromeProfileEmail ? ` (Google: ${fs.chromeProfileEmail})` : ""}. Hệ thống vừa mở profile này với Flow.`,
    `  Việc ĐẦU TIÊN: navigate (không truyền tabId) tới https://myaccount.google.com/ → get_page_text → kiểm tra đang đăng nhập ${who}.`,
    "  Sai tài khoản → list_connected_browsers, select_browser lần lượt từng trình duyệt và kiểm tra lại như trên; bỏ qua trình duyệt nào treo/hết hạn.",
    "  Không tìm thấy đúng profile → dừng, ghi result với status \"blocked\". KHÔNG dùng tài khoản khác.",
    `  Đúng rồi → mở ${FLOW_URL} trong tab của nhóm Claude và làm tiếp.`,
  ];
}

// ---------------- Start ----------------
export function startVideoJob(bizId: string, raw: unknown, actor: string) {
  const input = CreativeInput.parse(raw);
  for (const img of input.images) if (!existsSync(img.path)) throw new AppError("NO_FILE", `Không thấy ảnh ${img.path}`);
  const cfg = q.get<Row>("SELECT enabled FROM agent_config WHERE biz_id = ? AND agent_key = 'creative'", bizId);
  if (!cfg?.enabled) throw new AppError("AGENT_DISABLED", "Creative Agent đang tắt (Agent & Tác vụ)");
  const job = insert("creative_job", { biz_id: bizId, tool: input.tool, title: input.title, input, status: "queued", step: "Chờ trình duyệt rảnh", log: [], source_content_id: input.sourceContentId ?? null });
  const workdir = join(DATA_DIR, "creative", job.id);
  mkdirSync(join(workdir, "clips"), { recursive: true });
  update("creative_job", job.id, { workdir });
  // One Flow job at a time: they share the user's Chrome and Flow credits.
  enqueue("agent", "creative.flow", { jobId: job.id }, { bizId, idempotencyKey: `flow:${job.id}`, lockKey: "flow-chrome", maxAttempts: 1 });
  audit(bizId, actor, "creative.job_started", { type: "creative_job", id: job.id }, { tool: input.tool, title: input.title });
  emit(bizId, "creative.updated", { jobId: job.id, status: "queued" });
  return byId("creative_job", job.id);
}

// ---------------- Run (queue worker) ----------------
const running = new Map<string, AbortController>();
export function cancelVideoJob(bizId: string, jobId: string, actor: string) {
  const job = byId<Row>("creative_job", jobId);
  if (!job || job.biz_id !== bizId) throw new AppError("NOT_FOUND", "Không thấy job", 404);
  running.get(jobId)?.abort();
  if (["queued", "running"].includes(job.status)) update("creative_job", jobId, { status: "cancelled", step: "Đã hủy", ended_at: nowIso() });
  q.run("UPDATE job SET status = 'dead', last_error = 'cancelled' WHERE idempotency_key = ? AND status = 'queued'", `flow:${jobId}`);
  audit(bizId, actor, "creative.job_cancelled", { type: "creative_job", id: jobId });
  emit(bizId, "creative.updated", { jobId, status: "cancelled" });
}

export async function runVideoJob(jobId: string) {
  const job = byId<Row>("creative_job", jobId);
  if (!job || job.status !== "queued") return;
  const bizId = job.biz_id as string;
  const input = job.input as CreativeInput;
  const tool = FLOW_TOOLS[input.tool];
  const fs = flowSettings(bizId);
  const fail = (status: "failed" | "blocked", error: string) => {
    update("creative_job", jobId, { status, error, step: null, ended_at: nowIso() });
    emit(bizId, "creative.updated", { jobId, status });
    emit(bizId, "alert.raised", { level: "warning", text: `Video "${job.title}": ${error}` });
  };
  if (effectiveProvider(bizId).provider !== "claude_cli") return fail("blocked", "Cần chế độ Tài khoản Claude (Claude Code CLI) để điều khiển Chrome");
  if (!fs.chromeProfileDir && !fs.browserDeviceId) return fail("blocked", "Chưa chọn profile Chrome dùng cho Flow (Sản xuất video Flow → Chọn profile Chrome)");
  // Bring the chosen profile up with Flow open (the agent then confirms the account in-session).
  if (fs.chromeProfileDir && fs.chromeChannel) {
    try { openInProfile(fs.chromeChannel, fs.chromeProfileDir, FLOW_URL); } catch (e) { return fail("blocked", `Không mở được profile Chrome "${fs.chromeProfileName}": ${e instanceof Error ? e.message : e}`); }
  }
  const skill = q.get<Row>("SELECT body, version FROM skill WHERE biz_id = ? AND key = ? AND status = 'active'", bizId, tool.skill);
  if (!skill) return fail("blocked", `Chưa nạp skill ${tool.skill} (Skill & Nhân viên MKT → Đồng bộ lại)`);

  const workdir = job.workdir as string;
  const log: Row[] = [];
  let lastFlush = 0;
  const flush = (force = false) => {
    if (!force && Date.now() - lastFlush < 2000) return;
    lastFlush = Date.now();
    update("creative_job", jobId, { log: log.slice(-150), step: log.at(-1)?.text ?? null });
    emit(bizId, "creative.updated", { jobId, status: "running" });
  };
  update("creative_job", jobId, { status: "running", started_at: nowIso(), step: "Khởi động Claude + Chrome" });
  emit(bizId, "creative.updated", { jobId, status: "running" });

  const dna = input.brand === "taki" ? agentPlaybook(bizId, "content").text.split("<persona")[0] : "";
  const system = [
    `# SKILL ĐANG CHẠY: ${tool.skill} (v${skill.version})`,
    skill.body,
    "",
    "# CHẠY TRONG CỬA SỔ TERMINAL CỦA HỆ THỐNG TAKI AGENTIC AI (máy Mac cục bộ; CEO chỉ bấm cho phép quyền khi được hỏi)",
    ...browserInstructions(fs),
    "- Chỉ thao tác trên Flow (flow.google.com / labs.google). KHÔNG đăng nhập hộ, KHÔNG nhập mật khẩu, KHÔNG đổi cài đặt tài khoản, KHÔNG xóa gì. Chưa đăng nhập / hết tín dụng / không thấy công cụ → status \"blocked\" kèm lý do trong notes.",
    "- KHÔNG có người để hỏi: bỏ qua mọi bước AskUserQuestion/SendUserMessage/SendUserFile; thiếu thông tin thì tự giả định hợp lý và ghi vào notes.",
    "- Đây KHÔNG phải cloud: bỏ qua device_request_folder_access, device_stage_files, device_commit_files, /mnt/user-data.",
    `- Clip tải từ Chrome nằm ở ${DOWNLOADS}. Chỉ lấy clip MỚI của lần chạy này (theo thời gian sửa đổi sau lúc bắt đầu), chép vào ${join(workdir, "clips")} và đặt tên scene_01.mp4, scene_02.mp4… đúng thứ tự cảnh. Nếu là .zip thì unzip vào đó.`,
    "- Kiểm tra clip bằng ffprobe; soát lời thoại bằng lệnh: taki-video-stt <file1> <file2>… (trả JSON ngôn ngữ + văn bản).",
    `- HẬU KỲ: ffmpeg máy này KHÔNG có libass/drawtext nên KHÔNG dùng filter ass/subtitles/drawtext. Ghi lời thoại cuối cùng vào ${join(workdir, "script.json")} dạng [{"canh":1,"loi_thoai":"..."}] rồi chạy:`,
    `  taki-video-finish --clips <scene_01.mp4 …> --script ${join(workdir, "script.json")} --title "<tiêu đề hook>" --cta "<CTA>" --out ${join(workdir, "final.mp4")}`,
    "  Lệnh in JSON (thời lượng, độ phân giải, có âm thanh). Trích 2-3 khung hình bằng ffmpeg -ss <t> -frames:v 1 rồi Read để xem chữ không che mặt/sản phẩm.",
    "- Tối đa 3 lần tạo lại mỗi cảnh (tốn tín dụng Flow).",
    `- KẾT THÚC: dùng Write ghi kết quả JSON vào ${join(workdir, "result.json")} đúng schema sau rồi in "XONG — có thể đóng cửa sổ". Schema: ${JSON.stringify(Object.fromEntries(Object.entries(z.toJSONSchema(FlowResult, { target: "draft-7" }) as Row).filter(([k]) => k !== "$schema")))}`,
    `- Bị chặn/lỗi giữa chừng cũng PHẢI ghi result.json với status "blocked"/"failed" và lý do trong notes. finalPath = ${join(workdir, "final.mp4")} khi thành công. caption = caption đăng kênh (tiếng Việt, ≤ 300 ký tự, 3-5 hashtag). script = lời thoại từng cảnh.`,
    ...(dna ? ["", "# THƯƠNG HIỆU: TAKI (áp dụng DNA dưới đây cho lời thoại, caption, claim)", dna] : ["", "# THƯƠNG HIỆU: kênh khác/khách hàng. KHÔNG dùng giọng hay tên TAKI; theo thông tin trong brief."]),
  ].join("\n");
  const prompt = [
    `Công cụ Flow: ${tool.label}`,
    `Tên video: ${input.title}`,
    input.product ? `Sản phẩm: ${input.product}` : "",
    `Thông tin / chủ đề / kịch bản:\n${input.brief}`,
    input.durationSec ? `Thời lượng mong muốn: ${input.durationSec}s` : "",
    input.voice ? `Giọng: ${input.voice}` : "",
    input.hookTitle ? `Tiêu đề hook trên video: ${input.hookTitle}` : "",
    input.cta ? `CTA trên video: ${input.cta}` : "",
    input.images.length ? `Ảnh đầu vào (đường dẫn trên máy, upload bằng file_upload/upload_image):\n${input.images.map((i) => `- ${i.role}: ${i.path}`).join("\n")}` : "Không có ảnh đầu vào.",
    `Kênh sẽ đăng: ${input.channels.join(", ")} (dọc 9:16).`,
    "Hãy chạy toàn bộ skill đến khi có final.mp4 đã ghép + chèn chữ, rồi trả JSON.",
  ].filter(Boolean).join("\n\n");

  const ctrl = new AbortController();
  running.set(jobId, ctrl);
  const model = modelFor(bizId, "creative", "medium");
  let structured: unknown;
  const t0 = Date.now();
  try {
    structured = await runClaudeInTerminal({
      title: `Video Flow: ${job.title}`, prompt, system, model, cwd: workdir, signal: ctrl.signal,
      resultFile: join(workdir, "result.json"),
      timeoutMs: (fs.timeoutMin ?? tool.minutes + 30) * 60_000,
      allowedTools: [
        "mcp__claude-in-chrome", "Read", "Write", "Glob",
        "Bash(ffmpeg:*)", "Bash(ffprobe:*)", "Bash(taki-video-finish:*)", "Bash(taki-video-stt:*)",
        "Bash(cp:*)", "Bash(mv:*)", "Bash(ls:*)", "Bash(mkdir:*)", "Bash(unzip:*)", "Bash(stat:*)",
      ],
      addDirs: [workdir, DOWNLOADS, UPLOAD_DIR],
      onStep: (s) => { log.push(s); flush(); },
    });
  } catch (e) {
    running.delete(jobId);
    flush(true);
    if (byId<Row>("creative_job", jobId)?.status === "cancelled") return;
    return fail("failed", e instanceof Error ? e.message : String(e));
  }
  running.delete(jobId);
  flush(true);
  insert("model_usage", { biz_id: bizId, agent_key: "creative", provider: "claude_cli", model, tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_micros: 0, latency_ms: Date.now() - t0, at: nowIso() });
  const r = { structured, model, costMicros: 0 };

  const out = FlowResult.safeParse(r.structured);
  if (!out.success) return fail("failed", "Agent không trả kết quả đúng định dạng");
  update("creative_job", jobId, { model: r.model, cost_micros: r.costMicros });
  await completeVideoJob(jobId, out.data);
}

/** After a server restart: the Claude session keeps running in its Terminal window — wait for its result file. */
export async function reattachVideoJob(jobId: string) {
  const job = byId<Row>("creative_job", jobId);
  if (!job?.workdir) return;
  const fs = flowSettings(job.biz_id);
  const tool = FLOW_TOOLS[(job.input as CreativeInput).tool];
  const resultFile = join(job.workdir, "result.json");
  const deadline = new Date(job.started_at ?? job.created_at).getTime() + (fs.timeoutMin ?? tool.minutes + 30) * 60_000;
  update("creative_job", jobId, { step: "Máy chủ vừa khởi động lại — đang chờ kết quả từ cửa sổ Terminal" });
  while (Date.now() < deadline) {
    const cur = byId<Row>("creative_job", jobId);
    if (!cur || cur.status !== "running") return;
    if (existsSync(resultFile)) {
      try {
        const out = FlowResult.safeParse(JSON.parse(readFileSync(resultFile, "utf8")));
        if (out.success) return completeVideoJob(jobId, out.data);
      } catch { /* still being written */ }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  update("creative_job", jobId, { status: "failed", error: "Hết thời gian chờ kết quả từ Terminal", step: null, ended_at: nowIso() });
  emit(job.biz_id, "creative.updated", { jobId, status: "failed" });
}

/** Post-render half of a job: verify the file, register the asset, review, open the approval. */
export async function completeVideoJob(jobId: string, res: z.infer<typeof FlowResult>) {
  const job = byId<Row>("creative_job", jobId)!;
  const bizId = job.biz_id as string;
  const input = job.input as CreativeInput;
  const tool = FLOW_TOOLS[input.tool];
  const workdir = job.workdir as string;
  const skill = q.get<Row>("SELECT version FROM skill WHERE biz_id = ? AND key = ?", bizId, tool.skill);
  const fail = (status: "failed" | "blocked", error: string) => {
    update("creative_job", jobId, { status, error, step: null, ended_at: nowIso() });
    emit(bizId, "creative.updated", { jobId, status });
    emit(bizId, "alert.raised", { level: "warning", text: `Video "${job.title}": ${error}` });
  };
  update("creative_job", jobId, { result: res });
  if (res.status !== "done") return fail(res.status, res.notes || "Agent dừng giữa chừng");

  // Verify the file in code; never trust the model's claim that it exists.
  let finalPath = res.finalPath;
  if (!existsSync(finalPath)) return fail("failed", `Không thấy file thành phẩm ${finalPath}`);
  if (!finalPath.startsWith(workdir)) {
    const dest = join(workdir, basename(finalPath));
    copyFileSync(finalPath, dest);
    finalPath = dest;
  }
  const meta = probeVideo(finalPath);
  const asset = insert("creative_asset", {
    biz_id: bizId, job_id: jobId, kind: "video", path: finalPath, mime: "video/mp4", duration: meta.duration, width: meta.width, height: meta.height,
    size: statSync(finalPath).size, meta: { tool: input.tool, skill: `${tool.skill} v${skill?.version ?? "?"}`, scenes: res.scenes, redone: res.redoneScenes },
  });
  const scriptText = res.script.map((s) => `[Cảnh ${s.canh}] ${s.loi_thoai}`).join("\n");
  const ci = insert("content_item", {
    biz_id: bizId, agent_key: "creative", kind: "video", channel: input.channels[0], title: input.title,
    body: `${res.caption}\n\n---\nLời thoại:\n${scriptText}`, status: "in_review", asset_id: asset.id,
  });
  update("creative_job", jobId, { status: "done", step: "Đã xong, chờ duyệt", asset_id: asset.id, content_item_id: ci.id, ended_at: nowIso() });

  // Review: technical checks in code + script/caption through the normal Review Agent (Jev + MKT QA)
  const tech = [
    { check: "Có file MP4 hợp lệ", passed: meta.duration > 0, severity: "fatal" as const, detail: `${meta.duration.toFixed(1)}s` },
    { check: "Có âm thanh", passed: meta.hasAudio, severity: "major" as const },
    { check: "Khung dọc 9:16", passed: !!meta.width && !!meta.height && Math.abs(meta.width / meta.height - 9 / 16) < 0.02, severity: "minor" as const, detail: `${meta.width}x${meta.height}` },
  ];
  const dnaData = activeDna(bizId)?.data;
  const review = input.brand === "taki" && dnaData
    ? await reviewOutput({
      bizId, subjectType: "content_item", subjectId: ci.id, rubricKey: "video_final", output: { caption: res.caption, script: res.script }, dna: dnaData,
      contentView: { title: input.title, hook: res.script[0]?.loi_thoai ?? "", body: res.script.map((s) => s.loi_thoai).join("\n"), cta: res.script.at(-1)?.loi_thoai ?? "", channel: input.channels[0] },
      extraChecks: tech,
    })
    : null;
  if (review) update("content_item", ci.id, { review_score_id: review.id });
  update("content_item", ci.id, { status: "awaiting_approval" });
  const approval = insert("approval", {
    biz_id: bizId, subject_type: "creative_job", subject_id: jobId, agent_key: "creative", title: `Video: ${input.title}`,
    risk: tech.some((t) => !t.passed) || review?.verdict === "revise" ? "medium" : "low", status: "pending", review_score_id: review?.id ?? null,
    preview: { assetId: asset.id, duration: meta.duration, channels: input.channels, caption: res.caption, tool: tool.label, tech, notes: res.notes, redone: res.redoneScenes },
  });
  audit(bizId, "creative_agent", "creative.video_ready", { type: "creative_job", id: jobId }, { assetId: asset.id, duration: meta.duration });
  emit(bizId, "creative.updated", { jobId, status: "done" });
  emit(bizId, "approval.created", { approvalId: approval.id, title: approval.title });
}

export function probeVideo(path: string) {
  try {
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path], { encoding: "utf8" }));
    const v = (j.streams ?? []).find((s: Row) => s.codec_type === "video");
    return { duration: Number(j.format?.duration ?? 0), width: v?.width ?? null, height: v?.height ?? null, hasAudio: (j.streams ?? []).some((s: Row) => s.codec_type === "audio") };
  } catch (e) {
    logger.warn("ffprobe.failed", { path, error: String(e) });
    return { duration: 0, width: null, height: null, hasAudio: false };
  }
}

// ---------------- Draft upload to channels (after approval) ----------------
export function scheduleDrafts(bizId: string, jobId: string, actor: string) {
  const job = byId<Row>("creative_job", jobId)!;
  const input = job.input as CreativeInput;
  const created: string[] = [];
  for (const ch of input.channels) {
    const channel = q.get<Row>("SELECT * FROM channel WHERE biz_id = ? AND platform = ? AND enabled = 1", bizId, ch);
    if (!channel) continue;
    const pj = insert("publish_job", {
      biz_id: bizId, content_item_id: job.content_item_id, channel_id: channel.id, scheduled_at: nowIso(), status: "scheduled",
      idempotency_key: `draft:${job.id}:${channel.id}`, mode: "draft", asset_id: job.asset_id,
    });
    enqueue("publish", "publish.draft", { publishJobId: pj.id }, { bizId, idempotencyKey: `draftrun:${pj.id}` });
    created.push(pj.id);
  }
  update("content_item", job.content_item_id, { status: "approved" });
  update("creative_job", jobId, { status: "approved", step: "Đã duyệt, đang đăng nháp" });
  audit(bizId, actor, "creative.drafts_scheduled", { type: "creative_job", id: jobId }, { channels: input.channels });
  return created;
}

export async function runDraftUpload(publishJobId: string) {
  const pj = byId<Row>("publish_job", publishJobId);
  if (!pj || pj.status === "draft_uploaded") return;
  const asset = byId<Row>("creative_asset", pj.asset_id);
  const ci = byId<Row>("content_item", pj.content_item_id)!;
  const channel = byId<Row>("channel", pj.channel_id)!;
  if (!asset || !existsSync(asset.path)) throw new PermanentError("Không thấy file video để đăng nháp");
  const c = connector(platformForChannel(channel.platform));
  if (!c.uploadDraft) throw new PermanentError(`Kênh ${channel.platform} chưa hỗ trợ đăng nháp`);
  update("publish_job", pj.id, { status: "posting" });
  const caption = String(ci.body).split("\n---\n")[0];
  const r = await c.uploadDraft({ channelExternalId: channel.external_id, videoPath: asset.path, caption }, pj.idempotency_key);
  update("publish_job", pj.id, { status: "draft_uploaded", draft_url: r.draftUrl });
  const left = q.scalar<number>("SELECT COUNT(*) FROM publish_job WHERE content_item_id = ? AND mode = 'draft' AND status != 'draft_uploaded'", ci.id);
  if (!left) {
    update("content_item", ci.id, { status: "draft_on_channel" });
    q.run("UPDATE creative_job SET status = 'drafted', step = 'Đã lên nháp kênh' WHERE content_item_id = ?", ci.id);
    emit(pj.biz_id, "creative.updated", { status: "drafted" });
  }
  audit(pj.biz_id, "publishing", "post.draft_uploaded", { type: "publish_job", id: pj.id }, { channel: channel.name, draftUrl: r.draftUrl, mode: c.mode });
  emit(pj.biz_id, "post.published", { title: `Nháp trên ${channel.name}: ${ci.title}` });
}

// ---------------- Which connected browser is this Chrome profile? ----------------
const Probe = z.object({ found: z.boolean(), deviceId: z.string(), browserName: z.string(), accountEmail: z.string(), error: z.string() });
/**
 * Claude in Chrome lists browsers as "Browser 1/2…" without profile names, and stale entries hang.
 * Open the profile (so its extension is live), then ask each browser ON THIS COMPUTER which Google account
 * it is signed into (myaccount.google.com) and match the profile's email. Result is cached in settings.
 */
export async function findProfileBrowser(bizId: string, channel: string, dir: string) {
  const profile = listChromeProfiles().find((p) => p.channel === channel && p.dir === dir);
  if (!profile) throw new AppError("NO_PROFILE", "Không thấy profile Chrome này trên máy");
  openInProfile(channel, dir, FLOW_URL);
  await new Promise((r) => setTimeout(r, 5000));
  const target = profile.email ?? "";
  const probeDir = join(DATA_DIR, "creative", "_probe");
  mkdirSync(probeDir, { recursive: true });
  const resultFile = join(probeDir, `${Date.now().toString(36)}.json`);
  const structured = await runClaudeInTerminal({
    title: `Kiểm tra profile Chrome "${profile.name}"`, model: modelFor(bizId, "creative", "small"), cwd: probeDir, resultFile, timeoutMs: 6 * 60_000,
    prompt: [
      `Kiểm tra trình duyệt (Claude in Chrome) của profile Chrome "${profile.name}"${target ? ` — đăng nhập Google bằng ${target}` : ""}.`,
      "1) navigate (không truyền tabId) tới https://myaccount.google.com/ → get_page_text → đọc email Google đang đăng nhập.",
      target ? `2) Không trùng ${target} → list_connected_browsers, select_browser từng trình duyệt và kiểm tra lại; bỏ qua trình duyệt treo.` : "2) Ghi lại email thấy được.",
      `3) Ghi JSON vào ${resultFile} bằng Write: {"found": true|false, "deviceId": "<deviceId nếu biết, không thì chuỗi rỗng>", "browserName": "", "accountEmail": "", "error": ""}. Rồi đóng tab đã mở (tabs_close_mcp) và in "XONG — có thể đóng cửa sổ".`,
    ].join("\n"),
    system: "Bạn chỉ kiểm tra kết nối trình duyệt. Không bấm nút, không điền form, không đổi cài đặt nào.",
    allowedTools: ["mcp__claude-in-chrome", "Write"], addDirs: [probeDir],
  });
  const r = { structured };
  const res = Probe.parse(r.structured);
  if (res.found && res.deviceId) {
    const fs = flowSettings(bizId);
    if (fs.chromeChannel === channel && fs.chromeProfileDir === dir) {
      const cur = bizSettings(bizId) as any;
      update("biz", bizId, { settings: { ...cur, flow: { ...(cur.flow ?? {}), browserDeviceId: res.deviceId, browserLabel: `${res.browserName} · ${res.accountEmail || profile.name}` } } });
    }
  }
  return res;
}
export const verifyChromeProfile = findProfileBrowser;

// ---------------- Browser discovery (for the settings page) ----------------
export async function detectBrowsers(bizId: string) {
  const Out = z.object({ browsers: z.array(z.object({ deviceId: z.string(), name: z.string(), os: z.string() })), error: z.string() });
  const r = await runClaudeAgent({
    prompt: "Gọi list_connected_browsers và trả về danh sách trình duyệt (deviceId, tên/nhãn, hệ điều hành). Không làm gì khác. Nếu lỗi thì ghi vào error.",
    system: "Bạn chỉ liệt kê trình duyệt đã kết nối Claude in Chrome.", model: modelFor(bizId, "creative", "small"), chrome: true,
    cwd: DATA_DIR, timeoutMs: 120_000, addDirs: [],
    jsonSchema: Object.fromEntries(Object.entries(z.toJSONSchema(Out, { target: "draft-7" }) as Row).filter(([k]) => k !== "$schema")),
    allowedTools: ["mcp__claude-in-chrome__list_connected_browsers"],
  });
  return Out.parse(r.structured);
}
