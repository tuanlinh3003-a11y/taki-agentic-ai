import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { defaultBizId } from "@dotaka/db";
import { AppError, logger } from "@dotaka/shared";

export type Ctx = { bizId: string; actor: string; body: any; query: any; params: any; req: FastifyRequest };
type H = (c: Ctx) => unknown | Promise<unknown>;

// Idempotency-Key replay store (spec §14). Production: persist in Redis/Postgres with TTL.
const idem = new Map<string, { at: number; body: unknown }>();

export function routes(app: FastifyInstance) {
  const wrap = (h: H) => async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers["idempotency-key"] as string | undefined;
    if (key && req.method !== "GET") {
      const hit = idem.get(`${req.url}:${key}`);
      if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.body;
    }
    // Single-tenant local build: biz from the workspace; `biz_id` is already on every table for multi-biz later.
    // Ngân Nguyệt's tools call this API from the same machine and sign their changes (audit log shows who did what).
    const as = req.headers["x-taki-actor"];
    const actor = typeof as === "string" && as && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip) ? decodeURIComponent(as).slice(0, 60) : "Phòng Marketing TAKI";
    const ctx: Ctx = { bizId: defaultBizId(), actor, body: req.body ?? {}, query: req.query ?? {}, params: req.params ?? {}, req };
    const out = await h(ctx);
    if (key && req.method !== "GET") idem.set(`${req.url}:${key}`, { at: Date.now(), body: out ?? { ok: true } });
    return out ?? { ok: true };
  };
  return {
    get: (path: string, h: H) => app.get(path, wrap(h)),
    post: (path: string, h: H) => app.post(path, wrap(h)),
    put: (path: string, h: H) => app.put(path, wrap(h)),
    del: (path: string, h: H) => app.delete(path, wrap(h)),
  };
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  const requestId = req.id;
  if (err instanceof ZodError) return reply.status(400).send({ code: "VALIDATION", message: "Dữ liệu không hợp lệ", details: err.issues, requestId });
  if (err instanceof AppError) return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details, requestId });
  logger.error("api.error", { url: req.url, error: err instanceof Error ? err.stack : String(err) });
  return reply.status(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : "Lỗi hệ thống", requestId });
}
