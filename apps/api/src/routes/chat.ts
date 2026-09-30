import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IncomingMessage } from "@dotaka/contracts";
import { handback, replyAsHuman, transition } from "@dotaka/chat-engine";
import { verifyWebhook } from "@dotaka/connectors";
import { audit, byId, insert, q, update, type Row } from "@dotaka/db";
import { enqueue } from "@dotaka/orchestrator";
import { AppError, nowIso, sha256 } from "@dotaka/shared";
import { routes } from "../http.ts";

export function chatRoutes(app: FastifyInstance) {
  const r = routes(app);

  r.get("/v1/conversations", ({ bizId, query }) => {
    const f = query.filter as string | undefined;
    const where = f === "handoff" ? "AND state = 'handoff_pending'" : f === "unread" ? "AND unread > 0" : f === "hot" ? "AND lead_grade = 'hot'" : "";
    const ch = query.channel ? "AND channel = ?" : "";
    return q.all(`SELECT id, channel, customer_name, state, lead_grade, lead_score, intent, tags, unread, last_message_at, last_preview FROM conversation WHERE biz_id = ? ${where} ${ch} ORDER BY last_message_at DESC LIMIT 100`, ...(query.channel ? [bizId, query.channel] : [bizId]));
  });
  r.get("/v1/conversations/counts", ({ bizId }) => ({
    all: q.scalar("SELECT COUNT(*) FROM conversation WHERE biz_id = ?", bizId),
    unread: q.scalar("SELECT COUNT(*) FROM conversation WHERE biz_id = ? AND unread > 0", bizId),
    handoff: q.scalar("SELECT COUNT(*) FROM conversation WHERE biz_id = ? AND state = 'handoff_pending'", bizId),
    hot: q.scalar("SELECT COUNT(*) FROM conversation WHERE biz_id = ? AND lead_grade = 'hot'", bizId),
    byChannel: q.all("SELECT channel, COUNT(*) n FROM conversation WHERE biz_id = ? GROUP BY channel", bizId),
  }));
  r.get("/v1/conversations/:id", ({ bizId, params }) => {
    const c = byId<Row>("conversation", params.id);
    if (!c || c.biz_id !== bizId) throw new AppError("NOT_FOUND", "Không thấy hội thoại", 404);
    update("conversation", c.id, { unread: 0 });
    return {
      ...c,
      messages: q.all("SELECT id, direction, sender, body, meta, sent_at FROM message WHERE conversation_id = ? ORDER BY sent_at", c.id),
      lead: q.get("SELECT * FROM lead WHERE conversation_id = ?", c.id),
      attribution: q.all<Row>("SELECT al.*, a.name ad_name, p.title post_title FROM attribution_link al LEFT JOIN ad a ON a.id = al.ad_id LEFT JOIN post p ON p.id = al.post_id WHERE al.conversation_id = ? ORDER BY confidence DESC", c.id),
      orders: q.all("SELECT * FROM orders WHERE conversation_id = ?", c.id),
      followUps: q.all("SELECT * FROM follow_up_plan WHERE conversation_id = ?", c.id),
      judgments: q.all("SELECT id, purpose, source, model, answers, decision, latency_ms, created_at FROM jev_judgment WHERE subject_type = 'conversation' AND subject_id = ? ORDER BY created_at DESC LIMIT 12", c.id),
    };
  });
  r.post("/v1/conversations/:id/reply", async ({ bizId, params, body, actor }) => {
    const text = z.object({ text: z.string().min(1).max(2000) }).parse(body).text;
    await replyAsHuman(bizId, params.id, text, actor);
  });
  r.post("/v1/conversations/:id/handback", ({ bizId, params, actor }) => handback(bizId, params.id, actor));
  r.post("/v1/conversations/:id/resolve", ({ bizId, params, actor }) => {
    const c = byId<Row>("conversation", params.id);
    if (!c || c.biz_id !== bizId) throw new AppError("NOT_FOUND", "Không thấy hội thoại", 404);
    transition(c, "resolved", actor);
  });
  r.post("/v1/conversations/:id/order", ({ bizId, params, body, actor }) => {
    const c = byId<Row>("conversation", params.id);
    if (!c || c.biz_id !== bizId) throw new AppError("NOT_FOUND", "Không thấy hội thoại", 404);
    const p = z.object({ product: z.string(), total: z.number().int().nonnegative() }).parse(body);
    const src = q.get<Row>("SELECT source FROM attribution_link WHERE conversation_id = ? ORDER BY confidence DESC LIMIT 1", c.id);
    const o = insert("orders", { biz_id: bizId, conversation_id: c.id, customer_name: c.customer_name, product: p.product, total: p.total, status: "pending", source: src?.source ?? null });
    audit(bizId, actor, "order.draft_created", { type: "orders", id: o.id }, p);
    return o;
  });
  r.get("/v1/leads", ({ bizId }) => q.all("SELECT l.*, c.channel, c.state FROM lead l JOIN conversation c ON c.id = l.conversation_id WHERE l.biz_id = ? ORDER BY l.score DESC", bizId));
  r.get("/v1/orders", ({ bizId }) => q.all("SELECT * FROM orders WHERE biz_id = ? ORDER BY created_at DESC LIMIT 100", bizId));

  /** Dev helper: simulate an inbound customer message through the SAME webhook path. */
  r.post("/v1/simulate/message", ({ bizId, body }) => {
    const msg = IncomingMessage.parse({ ...body, messageId: body.messageId ?? `sim_${Date.now()}` });
    return ingest(bizId, "simulator", msg, true);
  });

  // ---------------- Webhook receiver (spec §6): verify -> raw_event -> ack -> queue ----------------
  app.post("/hooks/:platform", async (req, reply) => {
    const platform = (req.params as Row).platform as string;
    const raw = JSON.stringify(req.body ?? {});
    const ok = verifyWebhook(raw, req.headers["x-signature"] as string | undefined);
    const payload = req.body as Row;
    const dedupe = `${platform}:${payload?.messageId ?? sha256(raw)}`;
    if (q.get("SELECT id FROM raw_event WHERE dedupe_key = ?", dedupe)) return reply.send({ ok: true, duplicate: true });
    insert("raw_event", { platform, received_at: nowIso(), signature_ok: ok ? 1 : 0, payload, dedupe_key: dedupe });
    if (!ok) return reply.status(401).send({ code: "BAD_SIGNATURE", message: "Chữ ký webhook không hợp lệ" });
    const parsed = IncomingMessage.safeParse(payload);
    if (parsed.success) {
      const bizId = q.get<Row>("SELECT id FROM biz ORDER BY created_at LIMIT 1")!.id;
      ingest(bizId, platform, parsed.data, false);
    }
    return reply.send({ ok: true });
  });
}

function ingest(bizId: string, platform: string, msg: IncomingMessage, fromSimulator: boolean) {
  if (fromSimulator) insert("raw_event", { platform, received_at: nowIso(), signature_ok: 1, payload: msg, dedupe_key: `${platform}:${msg.messageId}` });
  // Per-conversation lock key => one turn at a time per conversation, parallel across conversations.
  const jobId = enqueue("chat", "chat.ingest", { bizId, msg }, { bizId, idempotencyKey: `ingest:${msg.channel}:${msg.messageId}`, lockKey: `conv:${msg.channel}:${msg.externalConversationId}`, maxAttempts: 3 });
  return { queued: true, jobId };
}
