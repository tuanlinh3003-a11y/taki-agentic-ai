import { useState, type ReactNode } from "react";
import { AlertTriangle, Ban, Building2, CheckCircle2, Circle, Gem, History, Megaphone, Package, Pencil, Plus, Target, Trash2, Users } from "lucide-react";
import { api, useApi } from "../lib/api";
import { timeAgo, vnd, vndFull } from "../lib/format";
import { Badge, Button, Card, Empty, Field, IconTile, Loading, Modal, PageHeader, Progress, Ring, inputCls, useToast } from "../components/ui";

const SECTION_LABEL: Record<string, string> = {
  company: "Thông tin công ty", positioning: "Định vị", audience: "Khách hàng mục tiêu", products: "Sản phẩm/Dịch vụ", offers: "Ưu đãi",
  voice: "Giọng điệu thương hiệu", differentiators: "Giá trị khác biệt", channels: "Kênh truyền thông", goals: "Mục tiêu kinh doanh", forbiddenClaims: "Tuyên bố bị cấm",
};
type EditKey = "brand" | "audience" | "differentiators" | "voice" | "products" | "forbiddenClaims" | "goals" | "offers" | "channels";
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function Dna() {
  const { data: d, reload } = useApi<any>("dna");
  const { data: ov } = useApi<any>("overview", ["metrics."]);
  const toast = useToast();
  const [edit, setEdit] = useState<{ key: EditKey; draft: any } | null>(null);
  const [saving, setSaving] = useState(false);
  if (!d) return <Loading />;
  const dna = d.data ?? {};
  const goals = dna.goals ?? {};
  const yearTarget = goals.yearTarget ?? ov?.goal?.yearTarget ?? 0;
  const runRate = ov?.goal?.runRate ?? goals.currentRunRate ?? 0;
  const goalPct = yearTarget ? Math.round((runRate / yearTarget) * 100) : 0;

  const open = (key: EditKey) => {
    const draft: Record<EditKey, any> = {
      brand: { ...(dna.company ?? {}), positioning: dna.positioning ?? "", mission: dna.mission ?? "" },
      audience: (dna.audience ?? []).map((a: any) => ({ name: a.name ?? "", pains: (a.pains ?? []).join("\n"), goals: (a.goals ?? []).join("\n") })),
      differentiators: (dna.differentiators ?? []).join("\n"),
      forbiddenClaims: (dna.forbiddenClaims ?? []).join("\n"),
      offers: (dna.offers ?? []).join("\n"),
      channels: (dna.channels ?? []).join("\n"),
      voice: { style: (dna.voice?.style ?? []).join(", "), do: (dna.voice?.do ?? []).join("\n"), dont: (dna.voice?.dont ?? []).join("\n"), sample: dna.voice?.sample ?? "" },
      products: (dna.products ?? []).map((p: any) => ({ ...p })),
      goals: { yearTarget: goals.yearTarget ?? 0, currentRunRate: goals.currentRunRate ?? 0, painPoint: goals.painPoint ?? "", competitors: (goals.competitors ?? []).join(", ") },
    };
    setEdit({ key, draft: draft[key] });
  };

  const save = async () => {
    if (!edit) return;
    const { key, draft } = edit;
    let data: any;
    if (key === "brand") { const { positioning, mission, ...company } = draft; data = { company, positioning, mission }; }
    else if (key === "audience") data = { audience: draft.filter((a: any) => a.name.trim()).map((a: any) => ({ name: a.name.trim(), pains: lines(a.pains), goals: lines(a.goals) })) };
    else if (key === "voice") data = { voice: { style: draft.style.split(",").map((s: string) => s.trim()).filter(Boolean), do: lines(draft.do), dont: lines(draft.dont), sample: draft.sample } };
    else if (key === "products") data = { products: draft.filter((p: any) => p.name.trim()) };
    else if (key === "goals") data = { goals: { ...goals, yearTarget: Number(draft.yearTarget) || 0, currentRunRate: Number(draft.currentRunRate) || 0, painPoint: draft.painPoint, competitors: draft.competitors.split(",").map((s: string) => s.trim()).filter(Boolean) } };
    else data = { [key]: lines(draft) };
    setSaving(true);
    try {
      const row = await api.put("dna", { data });
      toast(`Đã lưu DNA phiên bản ${row.version ?? "mới"}`);
      setEdit(null);
      reload();
    } catch (e: any) { toast(e.message, "err"); } finally { setSaving(false); }
  };

  const editBtn = (key: EditKey) => <Button size="sm" variant="ghost" icon={Pencil} onClick={() => open(key)}>Chỉnh sửa</Button>;
  const setDraft = (draft: any) => setEdit((e) => (e ? { ...e, draft } : e));

  return (
    <div className="space-y-6">
      <PageHeader title="Mục tiêu & DNA" subtitle="Thiết lập hồ sơ doanh nghiệp để Agent AI hiểu rõ thương hiệu, khách hàng và định hướng phát triển." />

      {d.warnings?.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1 space-y-1">{d.warnings.map((w: string) => <p key={w}>{w}</p>)}</div>
          <Button size="sm" onClick={() => open("products")}>Cập nhật giá</Button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Card title="Mức độ hoàn thiện DNA">
          <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col">
            <Ring value={d.completeness ?? 0} color={(d.completeness ?? 0) >= 90 ? "#10b981" : "#f59e0b"}>
              <div><p className="text-3xl font-bold text-ink">{d.completeness ?? 0}%</p><p className="text-xs text-muted">hoàn thiện</p></div>
            </Ring>
            <ul className="grid w-full gap-1.5 text-sm sm:grid-cols-2 lg:grid-cols-1">
              {d.sections?.map((s: any) => (
                <li key={s.key} className="flex items-center gap-2">
                  {s.done ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Circle className="h-4 w-4 text-muted" />}
                  <span className={s.done ? "text-ink" : "text-muted"}>{SECTION_LABEL[s.key] ?? s.key}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Target className="h-4 w-4 text-blue-600" />Mục tiêu kinh doanh 12 tháng</span>} action={editBtn("goals")}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Metric label="Mục tiêu năm" value={yearTarget ? vnd(yearTarget) : "Chưa đặt"} />
            <Metric label="Run-rate hiện tại" value={vnd(runRate)} />
            <Metric label="Điểm xuất phát" value={goals.currentRunRate ? vnd(goals.currentRunRate) : "Chưa đặt"} />
          </div>
          <div className="mt-5 space-y-2">
            <div className="flex justify-between text-sm"><span className="font-medium text-ink">Tiến độ so với mục tiêu</span><span className="text-muted">{goalPct}%</span></div>
            <Progress value={goalPct} tone={goalPct >= 100 ? "green" : "blue"} />
            {goals.currentRunRate > 0 && <p className="text-xs text-muted">Cần tăng {Math.round((yearTarget / goals.currentRunRate - 1) * 100)}% so với mức {vnd(goals.currentRunRate)}/năm · còn thiếu {vnd(Math.max(0, yearTarget - runRate))} run-rate</p>}
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-soft p-3"><p className="text-xs text-muted">Nỗi đau lớn nhất</p><p className="mt-1 font-medium text-ink">{goals.painPoint || "—"}</p></div>
            <div className="rounded-xl bg-soft p-3"><p className="text-xs text-muted">Đối thủ chính</p><div className="mt-1 flex flex-wrap gap-1">{(goals.competitors ?? []).map((c: string) => <Badge key={c} tone="red">{c}</Badge>)}</div></div>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard icon={Building2} tone="blue" title="Thông tin thương hiệu" action={editBtn("brand")}>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted">Tên</dt><dd className="font-medium text-ink">{dna.company?.name}</dd>
            <dt className="text-muted">Website</dt><dd className="text-ink">{dna.company?.website}</dd>
            <dt className="text-muted">Ngành</dt><dd className="text-ink">{dna.company?.industry}</dd>
            <dt className="text-muted">CEO</dt><dd className="text-ink">{dna.company?.ceo}</dd>
            <dt className="text-muted">Quy mô</dt><dd className="text-ink">{dna.company?.scale}</dd>
          </dl>
          <div className="mt-4 space-y-2 text-sm"><p className="text-xs font-medium uppercase text-muted">Định vị</p><p className="text-ink">{dna.positioning}</p>
            {dna.mission && <><p className="pt-1 text-xs font-medium uppercase text-muted">Sứ mệnh</p><p className="text-ink">{dna.mission}</p></>}</div>
        </SectionCard>

        <SectionCard icon={Users} tone="violet" title="Khách hàng mục tiêu" action={editBtn("audience")}>
          {(dna.audience ?? []).length === 0 ? <Empty>Chưa có chân dung khách hàng.</Empty> : (
            <div className="space-y-3">{dna.audience.map((a: any) => (
              <div key={a.name} className="rounded-xl border border-line p-3 text-sm">
                <p className="font-medium text-ink">{a.name}</p>
                <p className="mt-1 text-xs text-muted"><span className="font-medium text-rose-500">Nỗi đau:</span> {(a.pains ?? []).join(" · ")}</p>
                <p className="mt-0.5 text-xs text-muted"><span className="font-medium text-emerald-600">Mong muốn:</span> {(a.goals ?? []).join(" · ")}</p>
              </div>))}</div>
          )}
        </SectionCard>

        <SectionCard icon={Gem} tone="green" title="Giá trị khác biệt" action={editBtn("differentiators")}>
          <List items={dna.differentiators} />
          {(dna.offers ?? []).length > 0 && <div className="mt-4 border-t border-line pt-3"><div className="mb-2 flex items-center justify-between"><p className="text-xs font-medium uppercase text-muted">Ưu đãi đang áp dụng</p>{editBtn("offers")}</div><List items={dna.offers} /></div>}
        </SectionCard>

        <SectionCard icon={Megaphone} tone="pink" title="Giọng điệu thương hiệu" action={editBtn("voice")}>
          <div className="flex flex-wrap gap-1.5">{(dna.voice?.style ?? []).map((s: string) => <Badge key={s} tone="violet">{s}</Badge>)}</div>
          {dna.voice?.sample && <blockquote className="mt-3 border-l-4 border-violet-400 bg-soft px-3 py-2 text-sm italic text-ink">“{dna.voice.sample}”</blockquote>}
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><p className="mb-1 text-xs font-medium text-emerald-600">Nên</p><List items={dna.voice?.do} /></div>
            <div><p className="mb-1 text-xs font-medium text-rose-500">Tránh</p><List items={dna.voice?.dont} /></div>
          </div>
          {(dna.channels ?? []).length > 0 && <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3 text-xs text-muted">Kênh: {dna.channels.map((c: string) => <Badge key={c}>{c}</Badge>)}<button className="ml-auto text-blue-600" onClick={() => open("channels")}>Sửa kênh</button></div>}
        </SectionCard>

        <SectionCard icon={Package} tone="amber" title="Sản phẩm/Dịch vụ chính" action={editBtn("products")}>
          <div className="divide-y divide-line">{(dna.products ?? []).map((p: any) => (
            <div key={p.key ?? p.name} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0"><p className="text-sm font-medium text-ink">{p.name}</p><p className="text-xs text-muted">{p.summary}{p.format ? ` · ${p.format}` : ""}</p></div>
              <div className="shrink-0 text-right"><p className="text-sm font-semibold text-ink">{p.price == null ? "Liên hệ" : p.price ? vndFull(p.price) : "Miễn phí"}</p>{(p.sample || p.verified === false) && <Badge tone="amber">⚠️ chờ xác nhận</Badge>}{p.link && <p className="text-[11px] text-muted">{p.link}</p>}</div>
            </div>))}</div>
        </SectionCard>

        <SectionCard icon={Ban} tone="red" title="Tuyên bố bị cấm" action={editBtn("forbiddenClaims")}>
          <p className="mb-3 text-xs text-muted">Review Agent sẽ chặn mọi nội dung chứa các cụm từ này trước khi đến bàn Sếp.</p>
          <div className="flex flex-wrap gap-1.5">{(dna.forbiddenClaims ?? []).map((c: string) => <Badge key={c} tone="red">{c}</Badge>)}</div>
        </SectionCard>
      </div>

      <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4 text-muted" />Lịch sử phiên bản DNA</span>}>
        <div className="divide-y divide-line">{(d.versions ?? []).map((v: any) => (
          <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
            <span className="font-medium text-ink">Phiên bản {v.version}</span>
            <span className="text-muted">bởi {v.created_by} · {timeAgo(v.created_at)}</span>
            <Badge tone={v.status === "active" ? "green" : "gray"}>{v.status === "active" ? "Đang dùng" : "Lưu trữ"}</Badge>
          </div>))}</div>
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} wide={edit?.key === "products" || edit?.key === "audience"}
        title={edit ? `Chỉnh sửa: ${edit.key === "brand" ? "Thông tin thương hiệu" : SECTION_LABEL[edit.key]}` : ""}
        footer={<><Button onClick={() => setEdit(null)}>Hủy</Button><Button variant="primary" loading={saving} onClick={save}>Lưu phiên bản mới</Button></>}>
        {edit && <Editor k={edit.key} draft={edit.draft} set={setDraft} />}
      </Modal>
    </div>
  );
}

function Editor({ k, draft, set }: { k: EditKey; draft: any; set: (d: any) => void }) {
  if (k === "brand") return (
    <div className="grid gap-3 sm:grid-cols-2">
      {([["name", "Tên thương hiệu"], ["website", "Website"], ["industry", "Ngành"], ["ceo", "CEO"], ["scale", "Quy mô"]] as const).map(([f, l]) => (
        <Field key={f} label={l}><input className={inputCls} value={draft[f] ?? ""} onChange={(e) => set({ ...draft, [f]: e.target.value })} /></Field>))}
      <div className="sm:col-span-2"><Field label="Định vị"><textarea rows={3} className={inputCls} value={draft.positioning} onChange={(e) => set({ ...draft, positioning: e.target.value })} /></Field></div>
      <div className="sm:col-span-2"><Field label="Sứ mệnh"><textarea rows={2} className={inputCls} value={draft.mission} onChange={(e) => set({ ...draft, mission: e.target.value })} /></Field></div>
    </div>
  );
  if (k === "voice") return (
    <div className="space-y-3">
      <Field label="Phong cách" hint="Phân cách bằng dấu phẩy"><input className={inputCls} value={draft.style} onChange={(e) => set({ ...draft, style: e.target.value })} /></Field>
      <Field label="Nên làm" hint="Mỗi dòng một ý"><textarea rows={3} className={inputCls} value={draft.do} onChange={(e) => set({ ...draft, do: e.target.value })} /></Field>
      <Field label="Tránh" hint="Mỗi dòng một ý"><textarea rows={3} className={inputCls} value={draft.dont} onChange={(e) => set({ ...draft, dont: e.target.value })} /></Field>
      <Field label="Câu mẫu"><textarea rows={2} className={inputCls} value={draft.sample} onChange={(e) => set({ ...draft, sample: e.target.value })} /></Field>
    </div>
  );
  if (k === "goals") return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Mục tiêu năm (VND)" hint={vnd(Number(draft.yearTarget))}><input type="number" className={inputCls} value={draft.yearTarget} onChange={(e) => set({ ...draft, yearTarget: e.target.value })} /></Field>
      <Field label="Run-rate xuất phát (VND)" hint={vnd(Number(draft.currentRunRate))}><input type="number" className={inputCls} value={draft.currentRunRate} onChange={(e) => set({ ...draft, currentRunRate: e.target.value })} /></Field>
      <Field label="Nỗi đau lớn nhất"><input className={inputCls} value={draft.painPoint} onChange={(e) => set({ ...draft, painPoint: e.target.value })} /></Field>
      <Field label="Đối thủ" hint="Phân cách bằng dấu phẩy"><input className={inputCls} value={draft.competitors} onChange={(e) => set({ ...draft, competitors: e.target.value })} /></Field>
    </div>
  );
  if (k === "audience") return (
    <div className="space-y-3">
      {draft.map((a: any, i: number) => {
        const upd = (f: string, v: string) => set(draft.map((x: any, j: number) => (j === i ? { ...x, [f]: v } : x)));
        return (
          <div key={i} className="space-y-2 rounded-xl border border-line p-3">
            <div className="flex gap-2"><input className={inputCls} placeholder="Tên nhóm khách hàng" value={a.name} onChange={(e) => upd("name", e.target.value)} /><Button size="sm" variant="ghost" icon={Trash2} onClick={() => set(draft.filter((_: any, j: number) => j !== i))} /></div>
            <div className="grid gap-2 sm:grid-cols-2">
              <textarea rows={3} className={inputCls} placeholder="Nỗi đau (mỗi dòng một ý)" value={a.pains} onChange={(e) => upd("pains", e.target.value)} />
              <textarea rows={3} className={inputCls} placeholder="Mong muốn (mỗi dòng một ý)" value={a.goals} onChange={(e) => upd("goals", e.target.value)} />
            </div>
          </div>);
      })}
      <Button size="sm" icon={Plus} onClick={() => set([...draft, { name: "", pains: "", goals: "" }])}>Thêm nhóm khách hàng</Button>
    </div>
  );
  if (k === "products") return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Sửa giá sẽ bỏ nhãn “Giá mẫu” — agent sẽ báo giá theo con số này.</p>
      {draft.map((p: any, i: number) => {
        const upd = (patch: any) => set(draft.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={p.key ?? i} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_160px_auto]">
            <input className={inputCls} placeholder="Tên sản phẩm" value={p.name} onChange={(e) => upd({ name: e.target.value })} />
            <input type="number" className={inputCls} placeholder="Giá (để trống = liên hệ)" value={p.price ?? ""} onChange={(e) => upd({ price: e.target.value === "" ? null : Number(e.target.value), sample: false, verified: true })} />
            <div className="flex items-center gap-2">{p.sample && <Badge tone="amber">Giá mẫu</Badge>}<Button size="sm" variant="ghost" icon={Trash2} onClick={() => set(draft.filter((_: any, j: number) => j !== i))} /></div>
            <textarea rows={2} className={cxs} placeholder="Mô tả ngắn" value={p.summary ?? ""} onChange={(e) => upd({ summary: e.target.value })} />
          </div>);
      })}
      <Button size="sm" icon={Plus} onClick={() => set([...draft, { key: `sp-${Date.now()}`, name: "", summary: "", price: 0, sample: false }])}>Thêm sản phẩm</Button>
    </div>
  );
  return <Field label={SECTION_LABEL[k]} hint="Mỗi dòng một mục"><textarea rows={8} className={inputCls} value={draft} onChange={(e) => set(e.target.value)} /></Field>;
}
const cxs = `${inputCls} sm:col-span-3`;

function SectionCard({ icon, tone, title, action, children }: { icon: any; tone: any; title: string; action: ReactNode; children: ReactNode }) {
  return <Card title={<span className="flex items-center gap-3"><IconTile icon={icon} tone={tone} size="sm" />{title}</span>} action={action}>{children}</Card>;
}
function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div><p className="text-xs text-muted">{label}</p><p className="mt-1 text-xl font-bold tracking-tight text-ink">{value}</p></div>;
}
function List({ items }: { items?: string[] }) {
  if (!items?.length) return <p className="text-sm text-muted">—</p>;
  return <ul className="space-y-1.5 text-sm">{items.map((x) => <li key={x} className="flex gap-2 text-ink"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />{x}</li>)}</ul>;
}
