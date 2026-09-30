import { useState } from "react";
import { LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { api, useApi } from "../lib/api";
import { ddmm, vndFull } from "../lib/format";
import { Badge, Button, Card, Empty, Field, Loading, Modal, PageHeader, PlatformIcon, inputCls, useToast } from "../components/ui";

const OBJ: Record<string, string> = { messages: "Tin nhắn (Messenger)", engagement: "Tương tác bài viết", traffic: "Lượt truy cập website" };
const BLANK = { name: "", platform: "meta", definition: { objective: "messages", audience: { locations: ["VN"], ageMin: 28, ageMax: 55, genders: [], interests: [] }, budget: { type: "daily", amount: 1_000_000, currency: "VND" }, targetCpa: null, naming: "{date}_{page}_{postId}_{template}", cta: "MESSAGE_PAGE", placements: "auto", note: "" } };

export function AdTemplates() {
  const toast = useToast();
  const { data, reload } = useApi<any[]>("ad-templates");
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const d = edit.definition;
      const body = { name: edit.name, platform: edit.platform, definition: { ...d, targetCpa: d.targetCpa ? Number(d.targetCpa) : null, audience: { ...d.audience, interests: typeof d.audience.interests === "string" ? d.audience.interests.split(",").map((s: string) => s.trim()).filter(Boolean) : d.audience.interests } } };
      await (edit.id ? api.put(`ad-templates/${edit.id}`, body) : api.post("ad-templates", body));
      toast("Đã lưu mẫu quảng cáo"); setEdit(null); reload();
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  const setD = (patch: any) => setEdit({ ...edit, definition: { ...edit.definition, ...patch } });
  const setAud = (patch: any) => setD({ audience: { ...edit.definition.audience, ...patch } });

  return (
    <div className="space-y-6">
      <PageHeader title="Thư viện nội dung" subtitle="Mẫu quảng cáo: mục tiêu, tệp đối tượng, ngân sách — dùng khi Tạo chiến dịch nhanh và khi Khởi chạy theo lịch từ bài điểm cao."
        actions={<Button variant="primary" icon={Plus} onClick={() => setEdit(structuredClone(BLANK))}>Tạo mẫu</Button>} />
      <Card>
        {!data ? <Loading /> : data.length === 0 ? <Empty>Chưa có mẫu nào trong thư viện.</Empty> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.map((t) => {
              const d = t.definition ?? {};
              return (
                <div key={t.id} className="rounded-2xl border border-line p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-500/10 text-blue-600"><LayoutTemplate className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-ink">{t.name}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted"><PlatformIcon p={t.platform} size={14} />{OBJ[d.objective] ?? d.objective ?? "—"}</p>
                    </div>
                    <Badge tone="gray">{t.used} lần dùng</Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted">Độ tuổi</dt><dd className="text-ink">{d.audience?.ageMin ?? "?"}–{d.audience?.ageMax ?? "?"}</dd>
                    <dt className="text-muted">Vị trí</dt><dd className="text-ink">{(d.audience?.locations ?? ["VN"]).join(", ")}</dd>
                    <dt className="text-muted">Ngân sách gợi ý</dt><dd className="text-ink">{vndFull(d.budget?.amount)}</dd>
                    <dt className="text-muted">CPA mục tiêu</dt><dd className="text-ink">{d.targetCpa ? vndFull(d.targetCpa) : "—"}</dd>
                  </dl>
                  {d.audience?.interests?.length > 0 && <p className="mt-2 text-xs text-muted">Sở thích (ghi chú): {d.audience.interests.join(", ")}</p>}
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-muted">tạo {ddmm(t.created_at)}</span>
                    <span className="flex gap-1"><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEdit(structuredClone({ ...BLANK, ...t, definition: { ...BLANK.definition, ...d, audience: { ...BLANK.definition.audience, ...(d.audience ?? {}) }, budget: { ...BLANK.definition.budget, ...(d.budget ?? {}) } } }))}>Sửa</Button><Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDel(t)} aria-label="Xóa" /></span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? "Sửa mẫu quảng cáo" : "Tạo mẫu quảng cáo"}
        footer={<><Button onClick={() => setEdit(null)}>Hủy</Button><Button variant="primary" loading={busy} onClick={save}>Lưu mẫu</Button></>}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tên mẫu"><input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="VD: Tin nhắn CEO 28–55" /></Field>
              <Field label="Nền tảng"><select className={inputCls} value={edit.platform} onChange={(e) => setEdit({ ...edit, platform: e.target.value })}><option value="meta">Facebook (Meta Ads)</option><option value="tiktok">TikTok</option></select></Field>
            </div>
            <Field label="Mục tiêu"><select className={inputCls} value={edit.definition.objective} onChange={(e) => setD({ objective: e.target.value })}>{Object.entries(OBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Tuổi từ"><input type="number" min={13} max={65} className={inputCls} value={edit.definition.audience.ageMin} onChange={(e) => setAud({ ageMin: Number(e.target.value) })} /></Field>
              <Field label="Tuổi đến"><input type="number" min={13} max={65} className={inputCls} value={edit.definition.audience.ageMax} onChange={(e) => setAud({ ageMax: Number(e.target.value) })} /></Field>
              <Field label="Quốc gia (mã)" hint="VD: VN"><input className={inputCls} value={edit.definition.audience.locations.join(",")} onChange={(e) => setAud({ locations: e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) })} /></Field>
            </div>
            <Field label="Sở thích (ghi chú, cách nhau dấu phẩy)" hint="Meta dùng Advantage+ audience; sở thích được lưu làm ghi chú cho Ads Agent.">
              <input className={inputCls} value={Array.isArray(edit.definition.audience.interests) ? edit.definition.audience.interests.join(", ") : edit.definition.audience.interests} onChange={(e) => setAud({ interests: e.target.value })} placeholder="Quản trị doanh nghiệp, Khởi nghiệp, CEO" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ngân sách gợi ý/ngày (VNĐ)"><input type="number" step={100000} className={inputCls} value={edit.definition.budget.amount} onChange={(e) => setD({ budget: { ...edit.definition.budget, amount: Number(e.target.value) } })} /></Field>
              <Field label="CPA mục tiêu (VNĐ, tuỳ chọn)" hint="Dùng cho rule so với CPA mục tiêu"><input type="number" step={10000} className={inputCls} value={edit.definition.targetCpa ?? ""} onChange={(e) => setD({ targetCpa: e.target.value ? Number(e.target.value) : null })} /></Field>
            </div>
            <Field label="Quy tắc đặt tên"><input className={inputCls} value={edit.definition.naming} onChange={(e) => setD({ naming: e.target.value })} /></Field>
          </div>
        )}
      </Modal>

      <Modal open={!!del} onClose={() => setDel(null)} title="Xóa mẫu quảng cáo?"
        footer={<><Button onClick={() => setDel(null)}>Hủy</Button><Button variant="danger" icon={Trash2} onClick={async () => { try { await api.del(`ad-templates/${del.id}`); toast("Đã xóa mẫu"); setDel(null); reload(); } catch (e: any) { toast(e.message, "err"); } }}>Xóa</Button></>}>
        {del && <p className="text-sm text-muted">Xóa mẫu <b className="text-ink">{del.name}</b>? Quảng cáo đã tạo từ mẫu không bị ảnh hưởng.</p>}
      </Modal>
    </div>
  );
}
