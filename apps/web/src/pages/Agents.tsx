import { useState } from "react";
import { Bot, CheckCircle2, Clock, Coins, Cpu, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { api, useApi } from "../lib/api";
import { AGENT_LABEL, TASK_STATUS, num, timeAgo } from "../lib/format";
import { Badge, Button, Card, Empty, Loading, Modal, PageHeader, Progress, Stat, Toggle, cx, inputCls, useToast } from "../components/ui";

const AUTONOMY: Record<string, { label: string; hint: string }> = {
  L0: { label: "L0 · Gợi ý", hint: "Agent chỉ đề xuất, Sếp tự làm" },
  L1: { label: "L1 · Soạn sẵn chờ duyệt", hint: "Agent soạn, mọi thứ chờ Sếp duyệt trước khi ra ngoài" },
  L2: { label: "L2 · Tự làm trong giới hạn", hint: "Agent tự thực thi trong hạn mức đã đặt, vượt hạn mức mới hỏi" },
  L3: { label: "L3 · Tự chủ có giám sát", hint: "Agent tự quyết, Sếp xem báo cáo và có thể hoàn tác" },
};
const VERDICT: Record<string, { label: string; tone: "green" | "amber" | "red" | "violet" }> = { pass: { label: "Đạt", tone: "green" }, revise: { label: "Cần sửa", tone: "amber" }, block: { label: "Bị chặn", tone: "red" }, escalate: { label: "Cần Sếp xem", tone: "violet" } };
const RETRYABLE = ["failed", "blocked"];
const CANCELLABLE = ["pending", "ready", "running", "in_review", "revising", "awaiting_approval", "blocked", "failed"];
const usd = (micros: number | null | undefined) => `$${((micros ?? 0) / 1e6).toFixed((micros ?? 0) < 1e6 ? 3 : 2)}`;

// Agents that call Claude through the LLM Gateway (others are deterministic code and/or Jev).
const LLM_AGENTS = new Set(["assistant", "brief", "market_research", "strategy", "content", "video_script", "seo_web", "chat", "ads", "review"]);

export function Agents() {
  const agents = useApi<any[]>("agents", ["task.", "review."]);
  const tasks = useApi<any[]>("tasks", ["task.", "review."]);
  const usage = useApi<any>("usage", ["task.", "review."]);
  const schedules = useApi<any[]>("schedules");
  const llm = useApi<any>("llm");
  const toast = useToast();
  const [pending, setPending] = useState<{ agent: any; autonomy: string } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const putConfig = async (key: string, patch: any, msg: string) => {
    try { await api.put(`agents/${key}/config`, patch); toast(msg); agents.reload(); } catch (e: any) { toast(e.message, "err"); }
  };
  const changeAutonomy = (agent: any, autonomy: string) => {
    const cur = agent.config?.autonomy ?? agent.autonomy;
    if (autonomy === cur) return;
    if (autonomy > cur) setPending({ agent, autonomy }); // raising autonomy is sensitive → confirm
    else void putConfig(agent.key, { autonomy }, `${agent.label}: hạ về ${AUTONOMY[autonomy].label}`);
  };
  const taskAction = async (id: string, action: "retry" | "cancel") => {
    try { await api.post(`tasks/${id}/${action}`); toast(action === "retry" ? "Đã chạy lại tác vụ" : "Đã hủy tác vụ"); tasks.reload(); } catch (e: any) { toast(e.message, "err"); }
  };
  const toggleSchedule = async (s: any, enabled: boolean) => {
    try { await api.put(`schedules/${s.id}`, { enabled }); toast(`${enabled ? "Đã bật" : "Đã tắt"}: ${s.label ?? s.name}`); schedules.reload(); } catch (e: any) { toast(e.message, "err"); }
  };

  const u = usage.data;
  const tokens = (u?.byAgent ?? []).reduce((a: number, r: any) => a + (r.tokens_in ?? 0) + (r.tokens_out ?? 0), 0);
  const cost = (u?.byAgent ?? []).reduce((a: number, r: any) => a + (r.cost_micros ?? 0), 0) + (u?.jev?.cost_micros ?? 0);
  const taskList = (tasks.data ?? []).filter((t) => !filter || t.status === filter);

  return (
    <div className="space-y-6">
      <PageHeader title="Agent & Tác vụ" subtitle="Bật/tắt từng agent, đặt mức tự chủ và theo dõi mọi tác vụ đội AI đang làm cho doanh nghiệp." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat icon={Cpu} tone="blue" label="Token (7 ngày)" value={num(tokens)} sub={`${(u?.byAgent ?? []).reduce((a: number, r: any) => a + r.calls, 0)} lượt gọi model`} />
        <Stat icon={Coins} tone="amber" label="Chi phí AI (7 ngày)" value={usd(cost)} sub="Model + Jev" />
        <Stat icon={CheckCircle2} tone="green" label="Tác vụ hoàn thành" value={num(u?.tasksDone ?? 0)} />
        <Stat icon={Clock} tone="violet" label="Thời gian TB/tác vụ" value={u?.avgTaskMinutes != null ? (u.avgTaskMinutes < 1 ? `${Math.max(1, Math.round(u.avgTaskMinutes * 60))} giây` : `${u.avgTaskMinutes.toFixed(1)} phút`) : "—"} />
        <Stat icon={Sparkles} tone="pink" label="Lượt Jev phán đoán" value={num(u?.jev?.calls ?? 0)} sub={u?.jev?.latency != null ? `độ trễ TB ${Math.round(u.jev.latency)} ms` : undefined} />
      </div>

      {!agents.data ? <Loading /> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {agents.data.map((a) => {
            const cfg = a.config ?? {};
            const enabled = !!cfg.enabled;
            const budget = cfg.token_budget_day ?? a.tokenBudgetDay ?? 0;
            const usedPct = budget ? (a.tokensToday / budget) * 100 : 0;
            return (
              <div key={a.key} className={cx("flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]", !enabled && "opacity-60")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", enabled ? "bg-blue-500/10 text-blue-600" : "bg-soft text-muted")}><Bot className="h-5 w-5" /></span>
                    <div className="min-w-0"><p className="truncate font-semibold text-ink">{a.label}</p><p className="text-[11px] text-muted">{a.stage === 0 ? "Tổng điều phối" : `Khâu ${a.stage}`} · {a.done}/{a.tasks} tác vụ xong</p></div>
                  </div>
                  <Toggle checked={enabled} onChange={(v) => putConfig(a.key, { enabled: v }, `${a.label} đã ${v ? "bật" : "tắt"}`)} />
                </div>
                <p className="line-clamp-2 min-h-[2.5rem] text-xs text-muted">{a.description}</p>
                <select className={cx(inputCls, "py-1.5 text-xs")} value={cfg.autonomy ?? a.autonomy} onChange={(e) => changeAutonomy(a, e.target.value)} title={AUTONOMY[cfg.autonomy ?? a.autonomy]?.hint}>
                  {Object.entries(AUTONOMY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                {LLM_AGENTS.has(a.key) ? (
                  <select className={cx(inputCls, "py-1.5 text-xs")} value={a.modelOverride ?? ""} title={`Đang dùng: ${a.model}`}
                    onChange={(e) => putConfig(a.key, { model: e.target.value || null }, `${a.label}: ${e.target.value ? `dùng ${e.target.value}` : "theo tầng mặc định"}`)}>
                    <option value="">Model theo tầng ({a.model})</option>
                    {(llm.data?.catalog ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                ) : <p className="rounded-xl bg-soft px-3 py-1.5 text-[11px] text-muted">Không gọi Claude — chạy bằng mã tất định{a.usesJev?.length ? " + Jev" : ""}</p>}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-muted"><span>Token hôm nay</span><span className="tabular-nums">{num(a.tokensToday)} / {num(budget)}</span></div>
                  <Progress value={usedPct} tone={usedPct > 90 ? "red" : usedPct > 70 ? "amber" : "blue"} className="h-1.5" />
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  {a.avgReview != null && <Badge tone={a.avgReview >= 80 ? "green" : a.avgReview >= 65 ? "amber" : "red"}>Review TB {a.avgReview}</Badge>}
                  {a.usesJev?.length > 0 && <span title={a.usesJev.join(", ")} className="inline-flex max-w-full items-center gap-1 rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-600 px-2 py-0.5 text-[11px] font-semibold text-white"><Sparkles className="h-3 w-3 shrink-0" /><span className="truncate">Jev · {a.usesJev.join(", ")}</span></span>}
                </div>
              </div>);
          })}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card title="Tác vụ gần đây" action={
          <select className={cx(inputCls, "w-auto py-1.5 text-xs")} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Tất cả trạng thái</option>
            {Object.entries(TASK_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>} bodyClass="px-0 pb-2">
          {!tasks.data ? <Loading /> : taskList.length === 0 ? <div className="px-5"><Empty>Không có tác vụ nào.</Empty></div> : (
            <div className="divide-y divide-line">
              <div className="hidden grid-cols-[1fr_130px_120px_110px_90px_130px] gap-3 px-5 pb-2 text-xs font-medium text-muted lg:grid"><span>Tác vụ</span><span>Agent</span><span>Trạng thái</span><span>Tiến độ</span><span>Cập nhật</span><span className="text-right">Thao tác</span></div>
              {taskList.map((t) => {
                const st = TASK_STATUS[t.status] ?? { label: t.status, tone: "gray" as const };
                return (
                  <div key={t.id} onClick={() => setDetailId(t.id)} className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-5 py-3 hover:bg-soft lg:grid-cols-[1fr_130px_120px_110px_90px_130px]">
                    <div className="min-w-0"><p className="truncate text-sm font-medium text-ink">{t.title}</p><p className="truncate text-xs text-muted">{t.step ?? (t.error ? `Lỗi: ${t.error}` : "")}<span className="lg:hidden"> · {AGENT_LABEL[t.agent_key] ?? t.agent_key}</span></p></div>
                    <span className="hidden text-sm text-muted lg:block">{AGENT_LABEL[t.agent_key] ?? t.agent_key}</span>
                    <span><Badge tone={st.tone}>{st.label}</Badge></span>
                    <div className="flex items-center gap-2"><Progress value={(t.progress ?? 0) * 100} className="h-1.5" /><span className="w-8 text-right text-[11px] text-muted">{Math.round((t.progress ?? 0) * 100)}%</span></div>
                    <span className="text-xs text-muted">{timeAgo(t.updated_at)}</span>
                    <div className="col-span-2 flex justify-end gap-1.5 lg:col-span-1" onClick={(e) => e.stopPropagation()}>
                      {RETRYABLE.includes(t.status) && <Button size="sm" variant="soft" icon={RotateCcw} onClick={() => taskAction(t.id, "retry")}>Chạy lại</Button>}
                      {CANCELLABLE.includes(t.status) && <Button size="sm" variant="ghost" icon={XCircle} onClick={() => taskAction(t.id, "cancel")}>Hủy</Button>}
                    </div>
                  </div>);
              })}
            </div>
          )}
        </Card>

        <Card title="Kích hoạt tác vụ">
          <p className="mb-3 text-xs text-muted">Các tác vụ nền chạy định kỳ. Tắt khi Sếp muốn tạm dừng một mảng.</p>
          {!schedules.data ? <Loading /> : schedules.data.length === 0 ? <Empty>Chưa có lịch chạy.</Empty> : (
            <div className="divide-y divide-line">{schedules.data.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0"><p className="text-sm font-medium text-ink">{s.label ?? s.name}</p><p className="text-[11px] text-muted">{s.last_run_at ? `Lần chạy cuối ${timeAgo(s.last_run_at)}` : "Chưa chạy"}</p></div>
                <Toggle checked={!!s.enabled} onChange={(v) => toggleSchedule(s, v)} />
              </div>))}</div>
          )}
        </Card>
      </div>

      <Modal open={!!pending} onClose={() => setPending(null)} title="Nâng mức tự chủ của agent?"
        footer={<><Button onClick={() => setPending(null)}>Giữ nguyên</Button><Button variant="primary" onClick={() => { if (pending) void putConfig(pending.agent.key, { autonomy: pending.autonomy }, `${pending.agent.label}: đã chuyển sang ${AUTONOMY[pending.autonomy].label}`); setPending(null); }}>Xác nhận nâng quyền</Button></>}>
        {pending && (
          <div className="space-y-3 text-sm">
            <p className="text-ink"><b>{pending.agent.label}</b>: {AUTONOMY[pending.agent.config?.autonomy ?? pending.agent.autonomy]?.label} → <b>{AUTONOMY[pending.autonomy].label}</b></p>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-200">{AUTONOMY[pending.autonomy].hint}. Agent sẽ cần ít lần duyệt hơn — Sếp chỉ nên nâng khi điểm review đã ổn định.</div>
            {pending.agent.avgReview != null && <p className="text-xs text-muted">Điểm review trung bình hiện tại: {pending.agent.avgReview}/100</p>}
          </div>
        )}
      </Modal>

      <TaskDetail id={detailId} onClose={() => setDetailId(null)} onAction={(id, a) => { void taskAction(id, a); setDetailId(null); }} />
    </div>
  );
}

function TaskDetail({ id, onClose, onAction }: { id: string | null; onClose: () => void; onAction: (id: string, a: "retry" | "cancel") => void }) {
  const { data: t } = useApi<any>(id ? `tasks/${id}` : null, ["task.", "review."]);
  const show = !!id && t?.id === id;
  const st = show ? TASK_STATUS[t.status] ?? { label: t.status, tone: "gray" as const } : null;
  const review = t?.review?.result;
  return (
    <Modal open={!!id} onClose={onClose} wide title={show ? t.title : "Chi tiết tác vụ"}
      footer={show ? <>{RETRYABLE.includes(t.status) && <Button variant="soft" icon={RotateCcw} onClick={() => onAction(t.id, "retry")}>Chạy lại</Button>}{CANCELLABLE.includes(t.status) && <Button icon={XCircle} onClick={() => onAction(t.id, "cancel")}>Hủy tác vụ</Button>}<Button onClick={onClose}>Đóng</Button></> : undefined}>
      {!show ? <Loading /> : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={st!.tone}>{st!.label}</Badge><Badge tone="blue">{AGENT_LABEL[t.agent_key] ?? t.agent_key}</Badge><span className="text-xs text-muted">Sửa {t.revisions} lần · cập nhật {timeAgo(t.updated_at)}</span></div>
          {t.error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-rose-700 dark:text-rose-300"><b>Lỗi:</b> {t.error}</div>}
          {review && (
            <div className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between"><p className="font-medium text-ink">Kết quả review</p><Badge tone={VERDICT[review.verdict]?.tone ?? "gray"}>{Math.round(review.total)}/100 · {VERDICT[review.verdict]?.label ?? review.verdict}</Badge></div>
              <p className="mt-1 text-xs text-muted">{(review.deterministic ?? []).filter((c: any) => c.passed).length}/{(review.deterministic ?? []).length} kiểm tra cứng đạt · {(review.criteria ?? []).length} tiêu chí chấm bởi Jev{review.fatalFindings?.length ? ` · ${review.fatalFindings.length} lỗi nghiêm trọng` : ""}</p>
            </div>
          )}
          <div>
            <p className="mb-2 font-medium text-ink">Lượt chạy ({t.runs?.length ?? 0})</p>
            {!t.runs?.length ? <Empty>Chưa có lượt chạy.</Empty> : (
              <div className="overflow-x-auto rounded-xl border border-line scroll-thin">
                <table className="w-full min-w-[480px] text-xs">
                  <thead className="bg-soft text-muted"><tr><th className="px-3 py-2 text-left">#</th><th className="px-3 py-2 text-left">Model</th><th className="px-3 py-2 text-right">Token vào/ra</th><th className="px-3 py-2 text-right">Chi phí</th><th className="px-3 py-2 text-left">Trạng thái</th></tr></thead>
                  <tbody className="divide-y divide-line">{t.runs.map((r: any) => (
                    <tr key={r.id}><td className="px-3 py-2">{r.attempt}</td><td className="px-3 py-2">{r.model ?? "—"}</td><td className="px-3 py-2 text-right tabular-nums">{num(r.tokens_in)} / {num(r.tokens_out)}</td><td className="px-3 py-2 text-right tabular-nums">{usd(r.cost_micros)}</td>
                      <td className="px-3 py-2"><Badge tone={TASK_STATUS[r.status]?.tone ?? "gray"}>{TASK_STATUS[r.status]?.label ?? r.status}</Badge>{r.error && <p className="mt-1 text-rose-500">{r.error}</p>}</td></tr>))}</tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 font-medium text-ink">Nhật ký</p>
            {!t.history?.length ? <Empty>Chưa có nhật ký.</Empty> : (
              <ol className="space-y-2 border-l-2 border-line pl-4">{t.history.map((h: any) => (
                <li key={h.id} className="relative"><span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-blue-500" />
                  <p className="text-ink">{historyText(h)}</p><p className="text-[11px] text-muted">{h.actor} · {new Date(h.at).toLocaleString("vi-VN")}</p></li>))}</ol>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
function historyText(h: any) {
  if (h.event === "task.status" && h.data?.to) return `${TASK_STATUS[h.data.from]?.label ?? h.data.from ?? "—"} → ${TASK_STATUS[h.data.to]?.label ?? h.data.to}`;
  if (h.event === "task.cancelled") return "Tác vụ đã bị hủy";
  return h.event;
}
