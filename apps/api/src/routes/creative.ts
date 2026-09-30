import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { audit, bizSettings, byId, defaultBizId, q, update, type Row } from "@dotaka/db";
import { FLOW_TOOLS, UPLOAD_DIR, cancelVideoJob, detectBrowsers, flowSettings, startVideoJob } from "@dotaka/orchestrator";
import { AppError, uuidv7 } from "@dotaka/shared";
import { routes } from "../http.ts";

export function creativeRoutes(app: FastifyInstance) {
  const r = routes(app);

  r.get("/v1/creative/tools", ({ bizId }) => Object.entries(FLOW_TOOLS).map(([key, t]) => ({
    key, ...t, skillVersion: q.get<Row>("SELECT version FROM skill WHERE biz_id = ? AND key = ?", bizId, t.skill)?.version ?? null,
  })));
  r.get("/v1/creative/settings", ({ bizId }) => flowSettings(bizId));
  r.put("/v1/creative/settings", ({ bizId, body, actor }) => {
    const p = z.object({ browserDeviceId: z.string().nullable(), browserLabel: z.string().nullable().optional(), timeoutMin: z.number().int().min(15).max(180).optional() }).parse(body);
    const s = bizSettings(bizId) as any;
    const flow = { ...flowSettings(bizId), ...p };
    update("biz", bizId, { settings: { ...s, flow } });
    audit(bizId, actor, "creative.settings_changed", { type: "biz", id: bizId }, flow);
    return flow;
  });
  r.post("/v1/creative/browsers", async ({ bizId }) => detectBrowsers(bizId));

  r.get("/v1/creative/jobs", ({ bizId }) => q.all("SELECT id, tool, title, status, step, error, asset_id, content_item_id, model, cost_micros, started_at, ended_at, created_at FROM creative_job WHERE biz_id = ? ORDER BY created_at DESC LIMIT 50", bizId));
  r.get("/v1/creative/jobs/:id", ({ bizId, params }) => {
    const j = byId<Row>("creative_job", params.id);
    if (!j || j.biz_id !== bizId) throw new AppError("NOT_FOUND", "Không thấy job", 404);
    return {
      ...j, asset: j.asset_id ? byId("creative_asset", j.asset_id) : null,
      content: j.content_item_id ? byId("content_item", j.content_item_id) : null,
      drafts: j.content_item_id ? q.all("SELECT p.id, p.status, p.draft_url, p.error, c.platform, c.name FROM publish_job p JOIN channel c ON c.id = p.channel_id WHERE p.content_item_id = ? AND p.mode = 'draft'", j.content_item_id) : [],
      approval: q.get("SELECT id, status FROM approval WHERE subject_type = 'creative_job' AND subject_id = ? ORDER BY created_at DESC LIMIT 1", j.id),
    };
  });
  r.post("/v1/creative/jobs", ({ bizId, body, actor }) => startVideoJob(bizId, body, actor));
  r.post("/v1/creative/jobs/:id/cancel", ({ bizId, params, actor }) => cancelVideoJob(bizId, params.id, actor));

  // Image upload (base64 JSON keeps the stack dependency-free); files live in data/uploads.
  app.post("/v1/uploads", { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const p = z.object({ name: z.string().min(1).max(200), data: z.string().min(10) }).parse(req.body);
    const safe = basename(p.name).replace(/[^\w.\-]+/g, "_").slice(-80);
    if (!/\.(png|jpe?g|webp|heic)$/i.test(safe)) throw new AppError("BAD_TYPE", "Chỉ nhận ảnh png/jpg/webp/heic");
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const path = join(UPLOAD_DIR, `${uuidv7().slice(-12)}_${safe}`);
    writeFileSync(path, Buffer.from(p.data.replace(/^data:[^;]+;base64,/, ""), "base64"));
    audit(defaultBizId(), "Phòng Marketing TAKI", "upload.image", undefined, { path });
    return { path, size: statSync(path).size };
  });

  // Video streaming with HTTP Range so the <video> player can seek.
  app.get("/v1/media/:id", async (req, reply) => {
    const a = byId<Row>("creative_asset", (req.params as Row).id);
    if (!a || !existsSync(a.path)) return reply.status(404).send({ code: "NOT_FOUND", message: "Không thấy tệp" });
    const size = statSync(a.path).size;
    const range = req.headers.range;
    reply.header("accept-ranges", "bytes").type(a.mime);
    if ((req.query as Row).download) reply.header("content-disposition", `attachment; filename="${basename(a.path)}"`);
    if (range) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = Number(s);
      const end = e ? Number(e) : size - 1;
      reply.status(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
      return reply.send(createReadStream(a.path, { start, end }));
    }
    reply.header("content-length", size);
    return reply.send(createReadStream(a.path));
  });
}
