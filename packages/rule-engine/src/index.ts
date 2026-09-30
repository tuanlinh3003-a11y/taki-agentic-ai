import type { CanonicalMetrics, ConditionTree, RuleCondition, RuleDefinition } from "@dotaka/contracts";

/**
 * Deterministic rule evaluator (spec §8). Pure: no I/O, no model calls.
 * Callers load entities + metrics, call evaluateRule, then persist rule_run/actions.
 */
export type Window = "today" | "3d" | "7d" | "lifetime";

export interface RuleEntity {
  id: string;
  name: string;
  platform: string;
  level: "campaign" | "ad";
  status: "active" | "paused";
  dailyBudget: number | null;
  metrics: Partial<Record<Window, CanonicalMetrics>>;
  /** Oldest -> newest daily metrics, for "N consecutive days" conditions. */
  dailyHistory?: CanonicalMetrics[];
  refs?: Record<string, number | null | undefined>;
  /** String attributes filters can match on besides the name (account = ad_account id, campaign = campaign name). */
  attrs?: Record<string, string | null | undefined>;
  cooldownUntil?: string | null;
}

export interface EvalContext {
  now: Date;
  actionsToday: number;
  /** Sum of daily budgets of all active entities in scope (for maxTotalDailyBudget). */
  totalDailyBudget: number;
}

export interface ProposedAction {
  entityId: string;
  entityName: string;
  type: "pause_ad" | "resume_ad" | "update_budget" | "notify";
  params: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  reversible: boolean;
  blocked?: string;
}

export interface EvalResult {
  evaluated: number;
  matched: number;
  actions: ProposedAction[];
  skipped: { entityId: string; entityName: string; reason: string }[];
}

export function metricValue(m: CanonicalMetrics | undefined, metric: string): number | null {
  if (!m) return null;
  switch (metric) {
    case "cpa":
    case "cost_per_result":
      return m.results ? m.spend / m.results : null; // null, never 0, when no results
    case "ctr":
      return m.impressions ? m.clicks / m.impressions : null;
    case "cpm":
      return m.impressions ? (m.spend / m.impressions) * 1000 : null;
    case "roas":
      return m.spend && m.revenue != null ? m.revenue / m.spend : null;
    default: {
      const v = (m as Record<string, unknown>)[metric];
      return typeof v === "number" ? v : null;
    }
  }
}

function compare(a: number, op: RuleCondition["op"], b: number): boolean {
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
  }
}

function threshold(c: RuleCondition, e: RuleEntity): number | null {
  if (c.ref) {
    const r = e.refs?.[c.ref];
    return r == null ? null : r * (c.factor ?? 1);
  }
  return c.value ?? null;
}

function evalCond(c: RuleCondition, e: RuleEntity): { ok: boolean; unknown?: string; text: string } {
  const th = threshold(c, e);
  if (th == null) return { ok: false, unknown: `thiếu tham chiếu ${c.ref}`, text: "" };
  if (c.consecutiveDays && c.consecutiveDays > 1) {
    const hist = e.dailyHistory ?? [];
    if (hist.length < c.consecutiveDays) return { ok: false, unknown: `chưa đủ ${c.consecutiveDays} ngày dữ liệu`, text: "" };
    const lastN = hist.slice(-c.consecutiveDays);
    const ok = lastN.every((m) => {
      const v = metricValue(m, c.metric);
      return v != null && compare(v, c.op, th);
    });
    return { ok, text: `${c.metric} ${c.op} ${Math.round(th)} trong ${c.consecutiveDays} ngày liên tiếp` };
  }
  const v = metricValue(e.metrics[c.window], c.metric);
  if (v == null) return { ok: false, text: `${c.metric}(${c.window}) = không có dữ liệu` };
  return { ok: compare(v, c.op, th), text: `${c.metric}(${c.window}) = ${round(v)} ${c.op} ${round(th)}` };
}

function isCond(x: RuleCondition | ConditionTree): x is RuleCondition {
  return typeof (x as RuleCondition).metric === "string";
}

export function evalTree(t: ConditionTree, e: RuleEntity): { ok: boolean; reasons: string[]; unknown: string[] } {
  const reasons: string[] = [];
  const unknown: string[] = [];
  const run = (node: RuleCondition | ConditionTree): boolean => {
    if (isCond(node)) {
      const r = evalCond(node, e);
      if (r.unknown) unknown.push(r.unknown);
      if (r.ok) reasons.push(r.text);
      return r.ok;
    }
    if (node.all) return node.all.every(run);
    if (node.any) return node.any.some(run);
    return false;
  };
  const ok = run(t);
  return { ok, reasons, unknown };
}

function inScope(def: RuleDefinition, e: RuleEntity): boolean {
  if (def.scope.platform !== "any" && e.platform !== def.scope.platform) return false;
  if (e.level !== def.scope.level) return false;
  return (def.scope.filters ?? []).every((f) => {
    const v = f.field === "name" || !f.field ? e.name : String(e.attrs?.[f.field] ?? "");
    const lc = v.toLowerCase(), fv = f.value.toLowerCase();
    switch (f.op) {
      case "startsWith": return lc.startsWith(fv);
      case "contains": return lc.includes(fv);
      case "notContains": return !lc.includes(fv);
      case "in": return f.value.split(",").map((x) => x.trim()).filter(Boolean).includes(v);
      default: return v === f.value;
    }
  });
}

export function evaluateRule(def: RuleDefinition, entities: RuleEntity[], ctx: EvalContext): EvalResult {
  const out: EvalResult = { evaluated: 0, matched: 0, actions: [], skipped: [] };
  const g = def.budgetGuard;
  let executable = 0;
  let totalBudget = ctx.totalDailyBudget;

  for (const e of entities) {
    if (!inScope(def, e)) continue;
    out.evaluated++;

    // 1) minimum data: not enough data => no conclusion
    const today = e.metrics.today ?? e.metrics["3d"];
    if (def.minData.spend != null && (today?.spend ?? 0) < def.minData.spend && !hasResumeOnly(def)) {
      out.skipped.push({ entityId: e.id, entityName: e.name, reason: `chưa đủ dữ liệu (chi ${today?.spend ?? 0} < ${def.minData.spend})` });
      continue;
    }
    if (def.minData.impressions != null && (today?.impressions ?? 0) < def.minData.impressions && !hasResumeOnly(def)) {
      out.skipped.push({ entityId: e.id, entityName: e.name, reason: `chưa đủ hiển thị (${today?.impressions ?? 0} < ${def.minData.impressions})` });
      continue;
    }
    // 2) cooldown on the same object (also prevents oscillating opposite actions)
    if (e.cooldownUntil && new Date(e.cooldownUntil) > ctx.now) {
      out.skipped.push({ entityId: e.id, entityName: e.name, reason: `đang cooldown đến ${e.cooldownUntil}` });
      continue;
    }
    const r = evalTree(def.conditions, e);
    if (!r.ok) {
      if (r.unknown.length) out.skipped.push({ entityId: e.id, entityName: e.name, reason: r.unknown.join("; ") });
      continue;
    }
    out.matched++;
    const reason = r.reasons.join(" và ");

    for (const a of def.actions) {
      const base = { entityId: e.id, entityName: e.name, reason };
      let p: ProposedAction | null = null;
      if (a.type === "pause_ad") {
        if (e.status === "paused") continue;
        p = { ...base, type: "pause_ad", params: {}, before: { status: e.status }, after: { status: "paused" }, reversible: true };
      } else if (a.type === "resume_ad") {
        if (e.status === "active") continue;
        p = { ...base, type: "resume_ad", params: {}, before: { status: e.status }, after: { status: "active" }, reversible: true };
      } else if (a.type === "budget_change") {
        if (e.dailyBudget == null || e.status !== "active") continue;
        const want = a.pct ?? 0;
        const step = Math.sign(want) * Math.min(Math.abs(want), g.maxStepPct);
        let next = Math.round((e.dailyBudget * (1 + step / 100)) / 1000) * 1000;
        next = Math.min(next, g.maxDailyBudgetPerEntity);
        let blocked: string | undefined;
        const delta = next - e.dailyBudget;
        if (delta > 0 && totalBudget + delta > g.maxTotalDailyBudget) {
          const room = g.maxTotalDailyBudget - totalBudget;
          if (room <= 0) blocked = `vượt trần tổng ngân sách ngày ${g.maxTotalDailyBudget}`;
          else next = e.dailyBudget + Math.floor(room / 1000) * 1000;
        }
        if (next === e.dailyBudget && !blocked) blocked = "đã chạm trần ngân sách";
        const note = step !== want ? ` (cắt bước nhảy ${want}% → ${step}%)` : "";
        p = {
          ...base, reason: reason + note, type: "update_budget", params: { pct: step },
          before: { daily_budget: e.dailyBudget }, after: { daily_budget: next }, reversible: true, blocked,
        };
        if (!blocked) totalBudget += next - e.dailyBudget;
      } else if (a.type === "notify") {
        p = { ...base, type: "notify", params: { channel: a.channel ?? "telegram" }, before: {}, after: {}, reversible: false };
      }
      if (!p) continue;
      if (p.type !== "notify" && !p.blocked) {
        if (executable >= def.limits.maxActionsPerRun) p.blocked = `vượt ${def.limits.maxActionsPerRun} hành động/lần chạy`;
        else if (ctx.actionsToday + executable >= def.limits.maxActionsPerDay) p.blocked = `vượt ${def.limits.maxActionsPerDay} hành động/ngày`;
        else executable++;
      }
      out.actions.push(p);
    }
  }
  return out;
}

function hasResumeOnly(def: RuleDefinition) {
  return def.actions.every((a) => a.type === "resume_ad" || a.type === "notify");
}
const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 1000) / 1000);

/** Human-readable "what would this do" line for dry-run lists. */
export function describeAction(a: ProposedAction): string {
  const tag = a.blocked ? `[CHẶN: ${a.blocked}] ` : "";
  switch (a.type) {
    case "pause_ad": return `${tag}Tạm dừng "${a.entityName}" vì ${a.reason}`;
    case "resume_ad": return `${tag}Bật lại "${a.entityName}" vì ${a.reason}`;
    case "update_budget": return `${tag}Đổi ngân sách "${a.entityName}" ${a.before.daily_budget} → ${a.after.daily_budget} vì ${a.reason}`;
    case "notify": return `Báo Telegram về "${a.entityName}": ${a.reason}`;
  }
}
