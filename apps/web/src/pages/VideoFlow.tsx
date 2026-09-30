import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Clapperboard, Film, Globe, ImagePlus, Loader2, Play, Square, Trash2, UtensilsCrossed } from "lucide-react";
import { api, useApi } from "../lib/api";
import { timeAgo } from "../lib/format";
import { Badge, Button, Card, Empty, Field, Loading, Modal, PageHeader, PlatformIcon, cx, inputCls, useToast } from "../components/ui";

const TOOL_ICON: Record<string, any> = { "review-do-an-vat": UtensilsCrossed, "cooking-director": Clapperboard, cinematic: Film };
const STATUS: Record<string, [string, any]> = {
  queued: ["Chờ trình duyệt", "gray"], running: ["Đang sản xuất", "blue"], done: ["Xong, chờ duyệt", "green"],
  approved: ["Đã duyệt", "blue"], drafted: ["Đã lên nháp kênh", "green"],
  failed: ["Lỗi", "red"], blocked: ["Bị chặn", "amber"], cancelled: ["Đã hủy", "gray"],
};
const ROLES = ["Sản phẩm", "Nhân vật / người dẫn", "Nhân vật 2", "Bối cảnh / góc bếp", "Bao bì / đạo cụ", "Phong cách"];
const CHANNELS = ["tiktok", "facebook", "instagram"];

export function VideoFlow() {
  const [params] = useSearchParams();
  const tools = useApi<any[]>("creative/tools");
  const settings = useApi<any>("creative/settings");
  const { data: sys } = useApi<any>("system");
  const jobs = useApi<any[]>("creative/jobs", ["creative.", "approval."]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pickBrowser, setPickBrowser] = useState(false);
  const toast = useToast();

  const [form, setForm] = useState<any>({ tool: "review-do-an-vat", title: "", brand: "other", product: "", brief: "", durationSec: 48, voice: "", hookTitle: "", cta: "", channels: ["tiktok"], images: [] as { path: string; role: string; name: string }[] });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (p: any) => setForm((f: any) => ({ ...f, ...p }));

  // Prefill from an approved video script (Nội dung → "Sản xuất trên Flow")
  useEffect(() => {
    const from = params.get("from");
    if (!from) return;
    api.get(`content/${from}`).then((c) => set({ title: c.title, brief: c.body, brand: "taki", tool: "cinematic", sourceContentId: c.id, channels: [c.channel ?? "tiktok"].filter((x) => CHANNELS.includes(x)) })).catch(() => {});
  }, [params]);

  const upload = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 5 - form.images.length)) {
      const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
      try {
        const r = await api.post("/v1/uploads", { name: f.name, data });
        setForm((x: any) => ({ ...x, images: [...x.images, { path: r.path, role: ROLES[x.images.length] ?? "Ảnh", name: f.name }] }));
      } catch (e: any) { toast(e.message, "err"); }
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const { images, ...rest } = form;
      const j = await api.post("creative/jobs", { ...rest, durationSec: Number(form.durationSec) || undefined, images: images.map((i: any) => ({ path: i.path, role: i.role })), product: form.product || undefined, voice: form.voice || undefined, hookTitle: form.hookTitle || undefined, cta: form.cta || undefined });
      toast("Đã đưa vào hàng đợi sản xuất. Đừng đóng Chrome trong lúc agent làm việc.", "info");
      setConfirm(false);
      setSelected(j.id);
      jobs.reload();
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };

  const tool = tools.data?.find((t) => t.key === form.tool);
  const ready = settings.data?.browserDeviceId && sys?.llm?.provider === "claude_cli";
  const current = selected ?? jobs.data?.[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="Sản xuất video Flow" subtitle="Creative Agent chạy skill Flow của phòng MKT trên Chrome của Sếp: tạo video trên Google Flow, ghép + chèn phụ đề, rồi gửi duyệt và đăng nháp lên kênh." />

      <div className={cx("flex flex-wrap items-center gap-3 rounded-2xl border p-4 text-sm", ready ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/10")}>
        <Globe className="h-5 w-5" />
        <span>Trình duyệt Flow: {settings.data?.browserDeviceId ? <b>{settings.data.browserLabel ?? settings.data.browserDeviceId.slice(0, 8)}</b> : <b className="text-amber-700 dark:text-amber-300">chưa chọn</b>}</span>
        <span>· Claude: {sys?.llm?.provider === "claude_cli" ? <Badge tone="green">tài khoản CLI</Badge> : <Badge tone="amber">cần chế độ tài khoản Claude</Badge>}</span>
        <Button size="sm" onClick={() => setPickBrowser(true)}>{settings.data?.browserDeviceId ? "Đổi trình duyệt" : "Chọn trình duyệt"}</Button>
        <span className="text-xs text-muted">Chrome đó phải đang đăng nhập Google Flow và có các công cụ bên dưới trong project.</span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <Card title="Tạo video mới">
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {(tools.data ?? []).map((t) => {
                const Icon = TOOL_ICON[t.key] ?? Film;
                return (
                  <button key={t.key} onClick={() => set({ tool: t.key, durationSec: t.key === "cinematic" ? 60 : t.key === "cooking-director" ? 80 : 48 })} className={cx("rounded-xl border p-3 text-left transition", form.tool === t.key ? "border-blue-500 bg-blue-500/5 ring-2 ring-blue-500/15" : "border-line hover:bg-soft")}>
                    <Icon className="h-5 w-5 text-blue-600" />
                    <p className="mt-2 text-sm font-semibold">{t.label}</p>
                    <p className="text-[11px] text-muted">~{t.minutes} phút · skill v{t.skillVersion ?? "?"}</p>
                  </button>
                );
              })}
            </div>
            {tool && <p className="rounded-xl bg-soft p-3 text-xs text-muted">Cần: {tool.hint}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tên video"><input className={inputCls} value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Review bánh tráng trộn Tây Ninh" /></Field>
              <Field label="Thương hiệu / kênh" hint={form.brand === "taki" ? "Áp DNA TAKI (giọng, claim cấm)" : "Kênh affiliate/khách: không dùng giọng TAKI"}>
                <select className={inputCls} value={form.brand} onChange={(e) => set({ brand: e.target.value })}><option value="other">Kênh khác / khách hàng</option><option value="taki">TAKI Academy (áp DNA)</option></select>
              </Field>
              <Field label="Sản phẩm"><input className={inputCls} value={form.product} onChange={(e) => set({ product: e.target.value })} /></Field>
              <Field label="Thời lượng (giây)"><input type="number" className={inputCls} value={form.durationSec} onChange={(e) => set({ durationSec: e.target.value })} /></Field>
            </div>
            <Field label="Thông tin sản phẩm / chủ đề / kịch bản"><textarea rows={6} className={inputCls} value={form.brief} onChange={(e) => set({ brief: e.target.value })} placeholder="Giá, vị, điểm nổi bật, ưu đãi, link affiliate… hoặc chủ đề phim + thông điệp" /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Giọng"><input className={inputCls} value={form.voice} onChange={(e) => set({ voice: e.target.value })} placeholder="Nữ, miền Bắc, xưng chị" /></Field>
              <Field label="Tiêu đề hook"><input className={inputCls} value={form.hookTitle} onChange={(e) => set({ hookTitle: e.target.value })} /></Field>
              <Field label="CTA trên video"><input className={inputCls} value={form.cta} onChange={(e) => set({ cta: e.target.value })} placeholder="Bấm giỏ hàng ngay" /></Field>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Ảnh tham chiếu (tối đa 5)</p>
              <div className="flex flex-wrap gap-2">
                {form.images.map((im: any, i: number) => (
                  <div key={im.path} className="flex items-center gap-2 rounded-xl border border-line px-2 py-1.5 text-xs">
                    <select className="bg-transparent" value={im.role} onChange={(e) => set({ images: form.images.map((x: any, j: number) => (j === i ? { ...x, role: e.target.value } : x)) })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
                    <span className="max-w-[120px] truncate text-muted">{im.name}</span>
                    <button onClick={() => set({ images: form.images.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-3.5 w-3.5 text-muted" /></button>
                  </div>
                ))}
                {form.images.length < 5 && (
                  <label className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-1.5 text-xs text-muted hover:bg-soft"><ImagePlus className="h-4 w-4" />Thêm ảnh<input type="file" accept="image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} /></label>
                )}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Đăng nháp lên kênh (sau khi duyệt)</p>
              <div className="flex gap-2">{CHANNELS.map((c) => (
                <button key={c} onClick={() => set({ channels: form.channels.includes(c) ? form.channels.filter((x: string) => x !== c) : [...form.channels, c] })} className={cx("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs", form.channels.includes(c) ? "border-blue-500 bg-blue-500/10" : "border-line")}><PlatformIcon p={c} size={14} />{c}</button>
              ))}</div>
            </div>
            <div className="flex justify-end"><Button variant="primary" icon={Play} disabled={!ready || !form.title || form.brief.length < 5 || !form.channels.length} onClick={() => setConfirm(true)}>Bắt đầu sản xuất</Button></div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Các lần sản xuất">
            {!jobs.data ? <Loading /> : !jobs.data.length ? <Empty>Chưa có video nào.</Empty> : (
              <div className="space-y-1">
                {jobs.data.map((j) => (
                  <button key={j.id} onClick={() => setSelected(j.id)} className={cx("flex w-full items-center justify-between gap-2 rounded-xl p-2.5 text-left", j.id === current ? "bg-blue-500/10" : "hover:bg-soft")}>
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{j.title}</p><p className="truncate text-xs text-muted">{j.step ?? j.error ?? ""} · {timeAgo(j.created_at)}</p></div>
                    <Badge tone={STATUS[j.status]?.[1]}>{j.status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}{STATUS[j.status]?.[0] ?? j.status}</Badge>
                  </button>
                ))}
              </div>
            )}
          </Card>
          {current && <JobDetail id={current} />}
        </div>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Xác nhận sản xuất video trên Flow" footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Hủy</Button><Button variant="primary" loading={busy} onClick={start}>Bắt đầu</Button></>}>
        <div className="space-y-2 text-sm">
          <p><b>{tool?.label}</b> · {form.title}</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>Agent sẽ điều khiển Chrome "{settings.data?.browserLabel ?? "đã chọn"}" khoảng {tool?.minutes ?? 40} phút. Đừng đóng hay thao tác trên tab Flow trong lúc chạy.</li>
            <li>Mỗi lần tạo cảnh tốn tín dụng Google Flow (tối đa 3 lần làm lại mỗi cảnh).</li>
            <li>Video thành phẩm vào hộp Duyệt; chỉ sau khi duyệt mới đăng <b>bản nháp</b> lên {form.channels.join(", ")}.</li>
          </ul>
        </div>
      </Modal>
      <BrowserPicker open={pickBrowser} onClose={() => setPickBrowser(false)} onSaved={() => { setPickBrowser(false); settings.reload(); }} />
    </div>
  );
}

function JobDetail({ id }: { id: string }) {
  const { data: j, reload } = useApi<any>(`creative/jobs/${id}`, ["creative.", "approval.", "post."]);
  const toast = useToast();
  const elapsed = useMemo(() => (j?.started_at ? Math.round(((j.ended_at ? new Date(j.ended_at).getTime() : Date.now()) - new Date(j.started_at).getTime()) / 60000) : null), [j]);
  if (!j) return <Loading />;
  const cancel = async () => { try { await api.post(`creative/jobs/${id}/cancel`); toast("Đã hủy"); reload(); } catch (e: any) { toast(e.message, "err"); } };
  return (
    <Card title={j.title} action={["queued", "running"].includes(j.status) && <Button size="sm" variant="danger" icon={Square} onClick={cancel}>Dừng</Button>}>
      <div className="space-y-3 text-sm">
        <p className="flex flex-wrap items-center gap-2"><Badge tone={STATUS[j.status]?.[1]}>{STATUS[j.status]?.[0]}</Badge>{elapsed != null && <span className="text-xs text-muted">{elapsed} phút</span>}{j.model && <span className="text-xs text-muted">· {j.model}</span>}</p>
        {j.error && <p className="rounded-xl bg-rose-500/10 p-3 text-rose-700 dark:text-rose-300">{j.error}</p>}
        {j.asset && <video src={`/v1/media/${j.asset.id}`} controls className="mx-auto max-h-[480px] rounded-xl bg-black" />}
        {j.asset && <p className="text-xs text-muted">{j.asset.duration?.toFixed(1)}s · {j.asset.width}x{j.asset.height} · <a className="text-blue-600" href={`/v1/media/${j.asset.id}?download=1`}>Tải MP4</a></p>}
        {j.result?.caption && <div className="rounded-xl bg-soft p-3 text-xs"><p className="mb-1 font-semibold">Caption</p><p className="whitespace-pre-wrap">{j.result.caption}</p></div>}
        {j.result?.redoneScenes?.length > 0 && <p className="text-xs text-muted">Cảnh làm lại: {j.result.redoneScenes.map((r: any) => `#${r.scene} (${r.reason})`).join("; ")}</p>}
        {j.approval?.status === "pending" && <Link to={`/approvals?id=${j.approval.id}`}><Button size="sm" variant="primary">Duyệt video →</Button></Link>}
        {j.drafts?.length > 0 && (
          <div className="space-y-1">{j.drafts.map((d: any) => <p key={d.id} className="flex items-center gap-2 text-xs"><PlatformIcon p={d.platform} size={14} />{d.name}: {d.status === "draft_uploaded" ? <a href={d.draft_url} target="_blank" rel="noreferrer" className="text-blue-600">đã lên nháp</a> : d.status}{d.error ? ` · ${d.error}` : ""}</p>)}</div>
        )}
        {(j.log ?? []).length > 0 && (
          <details open={j.status === "running"}>
            <summary className="cursor-pointer text-xs font-medium">Nhật ký agent ({j.log.length} bước)</summary>
            <ol className="mt-2 max-h-72 space-y-1 overflow-auto text-[11px] scroll-thin">{[...j.log].reverse().slice(0, 60).map((s: any, i: number) => <li key={i} className={s.kind === "text" ? "text-ink" : "font-mono text-muted"}>{new Date(s.at).toLocaleTimeString("vi-VN")} · {s.text}</li>)}</ol>
          </details>
        )}
      </div>
    </Card>
  );
}

function BrowserPicker({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const detect = async () => {
    setLoading(true);
    try { const r = await api.post("creative/browsers"); setList(r.browsers); if (r.error) toast(r.error, "err"); } catch (e: any) { toast(e.message, "err"); } finally { setLoading(false); }
  };
  useEffect(() => { if (open && !list) void detect(); }, [open]);
  const choose = async (b: any) => { await api.put("creative/settings", { browserDeviceId: b.deviceId, browserLabel: `${b.name} (${b.os})` }); toast(`Đã chọn ${b.name}`); onSaved(); };
  return (
    <Modal open={open} onClose={onClose} title="Chọn Chrome dùng cho Google Flow">
      <p className="mb-3 text-sm text-muted">Chọn trình duyệt đang đăng nhập tài khoản Google có Flow và các công cụ (Review Đồ Ăn Vặt AI V6, Flow Cooking Director v2, Cinematic Short Film Studio).</p>
      {loading ? <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Đang hỏi Claude in Chrome…</p> : (
        <div className="space-y-2">
          {(list ?? []).map((b) => <button key={b.deviceId} onClick={() => choose(b)} className="flex w-full items-center justify-between rounded-xl border border-line p-3 text-left hover:bg-soft"><span><b>{b.name}</b> <span className="text-xs text-muted">{b.os} · {b.deviceId.slice(0, 8)}</span></span><span className="text-sm text-blue-600">Chọn</span></button>)}
          {list && !list.length && <Empty>Không thấy trình duyệt nào có Claude in Chrome.</Empty>}
          <Button size="sm" variant="ghost" onClick={detect}>Quét lại</Button>
        </div>
      )}
    </Modal>
  );
}
