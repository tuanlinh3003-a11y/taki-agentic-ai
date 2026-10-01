import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { audit, bizSettings, bus, byId, insert, q, update, type Row } from "@dotaka/db";
import { AppError, logger, nowIso, uuidv7 } from "@dotaka/shared";

/**
 * Bộ não (vault) — the company's second brain: plain Markdown files in folders (opens in Obsidian as-is), indexed
 * here for search (FTS5, accent-insensitive), [[wikilinks]] + backlinks, the knowledge graph, and for the agents:
 * notes under 05 - Knowledge feed the same retrieval the Chat/Content agents already use.
 * The files are the source of truth; the index is rebuilt from them at any time (scan) and kept fresh by a watcher.
 */
export const BRAIN_ROOT = resolve(process.env.BRAIN_ROOT ?? "data/brain");

/** Folder layout of a new vault (the JAVIS-style structure the CEO asked for). */
export const VAULT_FOLDERS: { name: string; about: string }[] = [
  { name: "00 - Dashboard", about: "Bảng điều khiển: số liệu chính, việc cần quyết, lối tắt. Hệ thống tự cập nhật." },
  { name: "01 - Daily Log", about: "Nhật ký từng ngày: hệ thống tự ghi những gì các agent đã làm; Sếp ghi thêm suy nghĩ." },
  { name: "01 - Inbox", about: "Hộp ghi nhanh: mọi thứ kéo/dán vào nằm ở đây trước, phân loại sau." },
  { name: "02 - Identity", about: "Danh tính doanh nghiệp: DNA thương hiệu, giá trị, giọng nói, định vị." },
  { name: "02 - Weekly Log", about: "Tổng kết tuần (tự tạo mỗi đầu tuần từ nhật ký ngày)." },
  { name: "03 - Monthly Log", about: "Tổng kết tháng (tự tạo đầu tháng)." },
  { name: "03 - Work", about: "Dự án / chiến dịch: mỗi mục tiêu một thư mục, gồm brief, nghiên cứu, chiến lược." },
  { name: "04 - Future Log", about: "Kế hoạch & nhắc việc tương lai (có hạn `due:` thì hệ thống nhắc đúng giờ)." },
  { name: "04 - Marketing Engine", about: "Cỗ máy marketing: nội dung, video, quảng cáo, báo cáo do agent tạo." },
  { name: "05 - Data Cache", about: "Dữ liệu thô / bảng số liệu lưu tạm cho phân tích." },
  { name: "05 - Knowledge", about: "Tri thức sản phẩm, chính sách, FAQ — các agent dùng để trả lời và viết nội dung." },
  { name: "06 - Life", about: "Đời sống cá nhân, sức khỏe, gia đình." },
  { name: "07 - Learning", about: "Học tập & bài học hệ thống tự rút ra từ kết quả." },
  { name: "08 - Thinking", about: "Suy nghĩ, ý tưởng, hội thoại với Ngân Nguyệt." },
  { name: "09 - Archive", about: "Lưu trữ: những gì đã xong / không dùng nữa." },
  { name: "10 - Wiki", about: "Wiki nội bộ: quy trình, skill, thuật ngữ — agent dùng làm tham chiếu." },
  { name: "agents", about: "Hồ sơ từng AI agent: vai trò, quyền, việc gần đây (tự cập nhật)." },
  { name: "assets", about: "Hình ảnh, logo, tài nguyên thương hiệu." },
  { name: "attachments", about: "Tệp đính kèm kéo/dán vào bộ não." },
];
/** Notes in this folder feed the agents' knowledge retrieval (also what Chat Agent may tell customers — so internal
 *  wiki / skills / identity notes are deliberately NOT included). */
const KNOWLEDGE_RE = /^05 - Knowledge\//;
const IGNORE_DIR = /^(\.|node_modules$)/;

// ---------------- Vaults ----------------
export function listVaults(bizId: string) {
  return q.all<Row>("SELECT * FROM brain_vault WHERE biz_id = ? ORDER BY created_at", bizId).map((v) => ({
    ...v, notes: q.scalar<number>("SELECT COUNT(*) FROM brain_note WHERE vault_id = ?", v.id) ?? 0, exists: existsSync(v.path),
  }));
}
export function activeVault(bizId: string): Row {
  const id = (bizSettings(bizId) as any).brain?.activeVault;
  const v = (id && byId<Row>("brain_vault", id)) || q.get<Row>("SELECT * FROM brain_vault WHERE biz_id = ? ORDER BY created_at LIMIT 1", bizId);
  if (!v) throw new AppError("NO_VAULT", "Chưa có bộ não nào", 404);
  return v;
}
export function setActiveVault(bizId: string, vaultId: string) {
  vaultOf(bizId, vaultId);
  const s = bizSettings(bizId) as any;
  update("biz", bizId, { settings: { ...s, brain: { ...(s.brain ?? {}), activeVault: vaultId } } });
}
export function vaultOf(bizId: string, id: string): Row {
  const v = id === "active" ? activeVault(bizId) : byId<Row>("brain_vault", id);
  if (!v || v.biz_id !== bizId) throw new AppError("NOT_FOUND", "Không thấy bộ não", 404);
  return v;
}
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "vault";

/** New managed vault in data/brain/<slug> with the full folder layout, or register an existing folder (e.g. an Obsidian vault). */
export function createVault(bizId: string, p: { name: string; path?: string; scaffold?: boolean }, actor: string) {
  const managed = !p.path;
  const path = p.path ? resolve(p.path) : join(BRAIN_ROOT, slug(p.name));
  if (q.get("SELECT id FROM brain_vault WHERE biz_id = ? AND path = ?", bizId, path)) throw new AppError("EXISTS", "Thư mục này đã là một bộ não");
  if (!managed && !existsSync(path)) throw new AppError("NO_DIR", "Không thấy thư mục này trên máy");
  mkdirSync(path, { recursive: true });
  const v = insert("brain_vault", { biz_id: bizId, name: p.name, path, managed: managed ? 1 : 0 });
  if (managed || p.scaffold) scaffold(path);
  audit(bizId, actor, "brain.vault_created", { type: "brain_vault", id: v.id }, { name: p.name, path, managed });
  scanVault(v.id);
  watchVault(v.id);
  return v;
}
/** Unregister (files are always kept on disk — deleting a whole brain is never automatic). */
export function removeVault(bizId: string, id: string, actor: string) {
  const v = vaultOf(bizId, id);
  watchers.get(v.id)?.close();
  watchers.delete(v.id);
  q.run("DELETE FROM brain_fts WHERE vault_id = ?", v.id);
  q.run("DELETE FROM brain_note WHERE vault_id = ?", v.id);
  q.run("DELETE FROM knowledge_chunk WHERE doc_id IN (SELECT id FROM knowledge_doc WHERE source LIKE ?)", `brain:${v.id}:%`);
  q.run("DELETE FROM knowledge_doc WHERE source LIKE ?", `brain:${v.id}:%`);
  q.run("DELETE FROM brain_vault WHERE id = ?", v.id);
  audit(bizId, actor, "brain.vault_removed", { type: "brain_vault", id: v.id }, { name: v.name, path: v.path, filesKept: true });
}
export function openVaultFolder(bizId: string, id: string, rel = "") {
  const v = vaultOf(bizId, id);
  const target = rel ? safePath(v, rel) : v.path;
  const p = spawn(process.platform === "darwin" ? "open" : "xdg-open", [existsSync(target) && statSync(target).isFile() ? dirname(target) : target], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
}

function scaffold(root: string) {
  for (const f of VAULT_FOLDERS) {
    mkdirSync(join(root, f.name), { recursive: true });
    const readme = join(root, f.name, `${f.name.replace(/^\d+ - /, "")} — Hướng dẫn.md`);
    if (!existsSync(readme) && !["assets", "attachments"].includes(f.name)) {
      writeFileSync(readme, `---\ntype: guide\n---\n# ${f.name}\n\n${f.about}\n\nVề trang chính: [[Dashboard]]\n`);
    }
  }
  const welcome = join(root, "00 - Dashboard", "Dashboard.md");
  if (!existsSync(welcome)) writeFileSync(welcome, `---\ntype: dashboard\n---\n# Dashboard\n\nBộ não của doanh nghiệp. Hệ thống tự cập nhật phần giữa hai dấu \`taki:auto\`; Sếp viết thêm bất cứ đâu.\n\n<!-- taki:auto -->\n_(đang tạo…)_\n<!-- /taki:auto -->\n`);
  const obs = join(root, ".obsidian");
  if (!existsSync(obs)) {
    mkdirSync(obs, { recursive: true });
    writeFileSync(join(obs, "app.json"), JSON.stringify({ attachmentFolderPath: "attachments", newFileLocation: "folder", newFileFolderPath: "01 - Inbox", useMarkdownLinks: false }, null, 2));
    writeFileSync(join(obs, "daily-notes.json"), JSON.stringify({ folder: "01 - Daily Log", format: "YYYY-MM-DD" }, null, 2));
  }
}

// ---------------- Safe file access ----------------
export function safePath(v: Row, rel: string) {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").some((s) => s === ".." || s === "")) throw new AppError("BAD_PATH", "Đường dẫn không hợp lệ");
  const abs = resolve(v.path, clean);
  if (abs !== v.path && !abs.startsWith(v.path + sep)) throw new AppError("BAD_PATH", "Đường dẫn nằm ngoài bộ não");
  return abs;
}
const relOf = (v: Row, abs: string) => relative(v.path, abs).split(sep).join("/");
const isNote = (p: string) => extname(p).toLowerCase() === ".md";
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Không tên";

// ---------------- Parsing ----------------
export function parseFrontmatter(text: string): { meta: Row; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Row = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && listKey) { (meta[listKey] as unknown[]).push(unquote(li[1])); continue; }
    const kv = line.match(/^([\w\-.]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, raw] = kv;
    listKey = null;
    if (raw === "") { meta[k] = []; listKey = k; continue; }
    if (/^\[.*\]$/.test(raw)) meta[k] = raw.slice(1, -1).split(",").map((x) => unquote(x.trim())).filter(Boolean);
    else if (raw === "true" || raw === "false") meta[k] = raw === "true";
    else if (/^-?\d+(\.\d+)?$/.test(raw)) meta[k] = Number(raw);
    else meta[k] = unquote(raw);
  }
  return { meta, body: text.slice(m[0].length) };
}
const unquote = (s: string) => s.replace(/^["'](.*)["']$/, "$1");
export function stringifyFrontmatter(meta: Row) {
  const lines = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]` : typeof v === "string" && /[:#\[\]{},]|^\s|\s$/.test(v) ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n` : "";
}
export function parseNote(text: string, rel: string) {
  const { meta, body } = parseFrontmatter(text);
  const noCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const h1 = noCode.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = String(meta.title ?? h1 ?? basename(rel, extname(rel))).slice(0, 200);
  const links = new Set<string>();
  for (const m of noCode.matchAll(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) links.add(m[1].trim());
  for (const m of noCode.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) if (!/^https?:/.test(m[1])) links.add(decodeURIComponent(m[1]).replace(/\.md$/, ""));
  const tags = new Set<string>([...(Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [])].map((t) => String(t).replace(/^#/, "")));
  for (const m of noCode.matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu)) if (!/^\d+$/.test(m[1])) tags.add(m[1]);
  const words = (noCode.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return { meta, body, title, links: [...links], tags: [...tags], words };
}

// ---------------- Index ----------------
function walk(dir: string, out: string[] = []) {
  let ents: import("node:fs").Dirent[] = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (IGNORE_DIR.test(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && isNote(e.name)) out.push(p);
  }
  return out;
}
function indexFile(v: Row, abs: string, mtime: string) {
  const rel = relOf(v, abs);
  const text = readFileSync(abs, "utf8");
  const n = parseNote(text, rel);
  const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const cur = q.get<Row>("SELECT id FROM brain_note WHERE vault_id = ? AND path = ?", v.id, rel);
  const row = { title: n.title, folder, tags: n.tags, meta: n.meta, refs: n.links, words: n.words, mtime };
  if (cur) update("brain_note", cur.id, row);
  else insert("brain_note", { biz_id: v.biz_id, vault_id: v.id, path: rel, ...row });
  q.run("DELETE FROM brain_fts WHERE vault_id = ? AND path = ?", v.id, rel);
  q.run("INSERT INTO brain_fts (vault_id, path, title, body) VALUES (?, ?, ?, ?)", v.id, rel, n.title, n.body);
  if (KNOWLEDGE_RE.test(rel) && !String(n.meta.source ?? "").startsWith("knowledge_doc:")) syncKnowledge(v, rel, n.title, n.body, n.tags);
}
function dropFromIndex(v: Row, rel: string) {
  q.run("DELETE FROM brain_note WHERE vault_id = ? AND path = ?", v.id, rel);
  q.run("DELETE FROM brain_fts WHERE vault_id = ? AND path = ?", v.id, rel);
  const doc = q.get<Row>("SELECT id FROM knowledge_doc WHERE source = ?", `brain:${v.id}:${rel}`);
  if (doc) { q.run("DELETE FROM knowledge_chunk WHERE doc_id = ?", doc.id); q.run("DELETE FROM knowledge_doc WHERE id = ?", doc.id); }
}
/** Knowledge/Wiki/Identity notes → knowledge_doc + chunks, so every agent's retrieval sees them. */
function syncKnowledge(v: Row, rel: string, title: string, body: string, tags: string[]) {
  const source = `brain:${v.id}:${rel}`;
  const clean = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").trim();
  let doc = q.get<Row>("SELECT id, body FROM knowledge_doc WHERE source = ?", source);
  if (doc && doc.body === clean) return;
  if (doc) update("knowledge_doc", doc.id, { title, body: clean, tags });
  else doc = insert("knowledge_doc", { biz_id: v.biz_id, title, kind: "doc", source, tags, body: clean, status: "processed" });
  q.run("DELETE FROM knowledge_chunk WHERE doc_id = ?", doc.id);
  clean.split(/\n\s*\n|\n(?=#)/).map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 8).slice(0, 400)
    .forEach((text, idx) => insert("knowledge_chunk", { biz_id: v.biz_id, doc_id: doc!.id, idx, text: text.slice(0, 1200), source_ref: `${title.slice(0, 40)}#${idx}` }));
}

/** Bring the index in line with the files (new / changed / deleted). Cheap: only changed mtimes are re-read. */
export function scanVault(vaultId: string) {
  const v = byId<Row>("brain_vault", vaultId);
  if (!v || !existsSync(v.path)) return { added: 0, changed: 0, removed: 0 };
  const known = new Map(q.all<Row>("SELECT path, mtime FROM brain_note WHERE vault_id = ?", v.id).map((r) => [r.path as string, r.mtime as string]));
  let added = 0, changed = 0, removed = 0;
  for (const abs of walk(v.path)) {
    const rel = relOf(v, abs);
    const mtime = statSync(abs).mtime.toISOString();
    const was = known.get(rel);
    known.delete(rel);
    if (was === mtime) continue;
    try { indexFile(v, abs, mtime); was ? changed++ : added++; } catch (e) { logger.warn("brain.index_failed", { rel, error: String(e) }); }
  }
  for (const rel of known.keys()) { dropFromIndex(v, rel); removed++; }
  update("brain_vault", v.id, { scanned_at: nowIso() });
  if (added || changed || removed) bus.emit("event", { id: uuidv7(), bizId: v.biz_id, type: "brain.updated", payload: { vaultId: v.id, added, changed, removed }, at: nowIso() });
  return { added, changed, removed };
}

const watchers = new Map<string, FSWatcher>();
export function watchVault(vaultId: string) {
  const v = byId<Row>("brain_vault", vaultId);
  if (!v || watchers.has(v.id) || !existsSync(v.path)) return;
  let t: NodeJS.Timeout | null = null;
  try {
    const w = watch(v.path, { recursive: true }, (_e, file) => {
      if (file && (String(file).split(/[\\/]/).some((s) => s.startsWith(".")) || !String(file).endsWith(".md"))) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { try { scanVault(v.id); } catch (e) { logger.warn("brain.scan_failed", { error: String(e) }); } }, 1200);
    });
    w.on("error", () => { watchers.delete(v.id); });
    watchers.set(v.id, w);
  } catch (e) { logger.warn("brain.watch_failed", { path: v.path, error: String(e) }); }
}
export function startBrain() {
  for (const v of q.all<Row>("SELECT id FROM brain_vault")) { try { scanVault(v.id); watchVault(v.id); } catch (e) { logger.warn("brain.start_failed", { error: String(e) }); } }
}

// ---------------- Notes ----------------
/** Write a note file and index it right away (the watcher would too, ~1s later). */
export function writeNoteFile(v: Row, rel: string, content: string) {
  if (!isNote(rel)) throw new AppError("BAD_PATH", "Ghi chú phải là file .md");
  const abs = safePath(v, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  indexFile(v, abs, statSync(abs).mtime.toISOString());
  bus.emit("event", { id: uuidv7(), bizId: v.biz_id, type: "brain.updated", payload: { vaultId: v.id, path: rel }, at: nowIso() });
  return rel;
}
export function readNoteFile(v: Row, rel: string) {
  const abs = safePath(v, rel);
  if (!existsSync(abs)) throw new AppError("NOT_FOUND", `Không thấy ghi chú ${rel}`, 404);
  return readFileSync(abs, "utf8");
}
export const noteExists = (v: Row, rel: string) => existsSync(safePath(v, rel));
/** A free path inside folder for title (adds " 2", " 3"… when taken). */
export function freePath(v: Row, folder: string, title: string) {
  const base = `${folder ? `${folder.replace(/\/+$/, "")}/` : ""}${safeName(title)}`;
  let rel = `${base}.md`;
  for (let i = 2; noteExists(v, rel); i++) rel = `${base} ${i}.md`;
  return rel;
}
export function createNote(v: Row, p: { folder?: string; title: string; content?: string; meta?: Row }) {
  const rel = freePath(v, p.folder ?? "01 - Inbox", p.title);
  const body = p.content ?? "";
  const text = `${stringifyFrontmatter({ created: new Date().toISOString().slice(0, 10), ...(p.meta ?? {}) })}${/^#\s/m.test(body) ? "" : `# ${p.title}\n\n`}${body}\n`;
  return writeNoteFile(v, rel, text);
}
export function appendToNote(v: Row, rel: string, text: string) {
  const cur = noteExists(v, rel) ? readNoteFile(v, rel) : `# ${basename(rel, ".md")}\n`;
  return writeNoteFile(v, rel, `${cur.replace(/\s*$/, "")}\n\n${text.trim()}\n`);
}
/** Replace (or add) the auto-generated block between `<!-- taki:auto -->` markers; the CEO's own text is kept. */
export function upsertAutoBlock(v: Row, rel: string, block: string, header: () => string) {
  const START = "<!-- taki:auto -->", END = "<!-- /taki:auto -->";
  const cur = noteExists(v, rel) ? readNoteFile(v, rel) : header();
  const wrapped = `${START}\n${block.trim()}\n${END}`;
  const re = /<!-- taki:auto -->[\s\S]*?<!-- \/taki:auto -->/;
  const next = re.test(cur) ? cur.replace(re, wrapped) : `${cur.replace(/\s*$/, "")}\n\n${wrapped}\n`;
  if (next !== cur) writeNoteFile(v, rel, next);
  return rel;
}

/** Rename/move a note and rewrite [[links]] that pointed at its old name (like Obsidian). */
export function renameNote(v: Row, from: string, to: string, actor: string) {
  if (!isNote(to)) to = `${to}.md`;
  const a = safePath(v, from), b = safePath(v, to);
  if (!existsSync(a)) throw new AppError("NOT_FOUND", "Không thấy ghi chú", 404);
  if (existsSync(b)) throw new AppError("EXISTS", "Đã có ghi chú ở vị trí này");
  mkdirSync(dirname(b), { recursive: true });
  renameSync(a, b);
  dropFromIndex(v, from);
  indexFile(v, b, statSync(b).mtime.toISOString());
  const oldBase = basename(from, ".md"), newBase = basename(to, ".md");
  let relinked = 0;
  if (oldBase !== newBase) {
    const re = new RegExp(`\\[\\[(${oldBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})((?:[#^|][^\\]]*)?)\\]\\]`, "g");
    for (const n of q.all<Row>("SELECT path FROM brain_note WHERE vault_id = ? AND refs LIKE ?", v.id, `%${oldBase}%`)) {
      const text = readNoteFile(v, n.path);
      const next = text.replace(re, `[[${newBase}$2]]`);
      if (next !== text) { writeNoteFile(v, n.path, next); relinked++; }
    }
  }
  audit(v.biz_id, actor, "brain.note_renamed", { type: "brain_vault", id: v.id }, { from, to, relinked });
  return { path: relOf(v, b), relinked };
}
/** Delete = move into the vault's .trash folder (Obsidian convention) — recoverable, never permanent. */
export function trashNote(v: Row, rel: string, actor: string) {
  const a = safePath(v, rel);
  if (!existsSync(a)) throw new AppError("NOT_FOUND", "Không thấy ghi chú", 404);
  const dest = join(v.path, ".trash", `${Date.now()}-${basename(rel)}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(a, dest);
  dropFromIndex(v, rel);
  audit(v.biz_id, actor, "brain.note_trashed", { type: "brain_vault", id: v.id }, { path: rel, trash: relOf(v, dest) });
  bus.emit("event", { id: uuidv7(), bizId: v.biz_id, type: "brain.updated", payload: { vaultId: v.id, path: rel }, at: nowIso() });
}
export function createFolder(v: Row, rel: string) {
  mkdirSync(safePath(v, rel), { recursive: true });
  return rel;
}
export function saveAttachment(v: Row, name: string, data: Buffer) {
  if (data.length > 30 * 1024 * 1024) throw new AppError("TOO_BIG", "Tệp tối đa 30MB");
  const clean = safeName(basename(name).replace(/\.[^.]+$/, "")) + (extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "") || "");
  let rel = `attachments/${clean}`;
  for (let i = 2; existsSync(safePath(v, rel)); i++) rel = `attachments/${clean.replace(/(\.[^.]+)?$/, ` ${i}$1`)}`;
  mkdirSync(join(v.path, "attachments"), { recursive: true });
  writeFileSync(safePath(v, rel), data);
  return rel;
}

// ---------------- Tree, search, links, graph ----------------
export function vaultTree(v: Row) {
  type Node = { name: string; path: string; type: "folder" | "note"; title?: string; count: number; children?: Node[] };
  const root: Node = { name: v.name, path: "", type: "folder", count: 0, children: [] };
  const folders = new Map<string, Node>([["", root]]);
  const folderNode = (rel: string): Node => {
    if (folders.has(rel)) return folders.get(rel)!;
    const parent = folderNode(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
    const n: Node = { name: rel.split("/").pop()!, path: rel, type: "folder", count: 0, children: [] };
    parent.children!.push(n);
    folders.set(rel, n);
    return n;
  };
  const dirs = (dir: string) => {
    let ents: import("node:fs").Dirent[] = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !IGNORE_DIR.test(e.name)) { folderNode(relOf(v, join(dir, e.name))); dirs(join(dir, e.name)); }
  };
  dirs(v.path);
  for (const n of q.all<Row>("SELECT path, title, folder FROM brain_note WHERE vault_id = ?", v.id)) {
    const f = folderNode(n.folder);
    f.children!.push({ name: basename(n.path, ".md"), path: n.path, type: "note", title: n.title, count: 1 });
    let p: string = n.folder;
    while (true) {
      folders.get(p)!.count++;
      if (p === "") break;
      p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    }
  }
  const sort = (n: Node) => { n.children?.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "vi", { numeric: true }) : a.type === "folder" ? -1 : 1)); n.children?.forEach(sort); };
  sort(root);
  return root;
}

const ftsQuery = (s: string) => s.normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
export function searchNotes(v: Row, text: string, mode: "name" | "content" = "content", limit = 30) {
  const fq = ftsQuery(text);
  if (!fq) return [];
  const col = mode === "name" ? `{title} : (${fq})` : fq;
  try {
    return q.all<Row>(`SELECT path, title, snippet(brain_fts, 3, '«', '»', '…', 14) snippet FROM brain_fts WHERE vault_id = ? AND brain_fts MATCH ? ORDER BY rank LIMIT ?`, v.id, col, limit);
  } catch {
    return q.all<Row>("SELECT path, title, '' snippet FROM brain_note WHERE vault_id = ? AND (title LIKE ? OR path LIKE ?) LIMIT ?", v.id, `%${text}%`, `%${text}%`, limit);
  }
}

/** Link target → note path, Obsidian-style: full path, then file name (case-insensitive). */
function resolver(v: Row) {
  const rows = q.all<Row>("SELECT path, title, folder, meta, refs, tags, words, mtime FROM brain_note WHERE vault_id = ?", v.id);
  const byPath = new Map<string, string>(), byBase = new Map<string, string>();
  for (const r of rows) {
    const noExt = (r.path as string).replace(/\.md$/i, "").toLowerCase();
    byPath.set(noExt, r.path);
    const b = basename(noExt);
    if (!byBase.has(b)) byBase.set(b, r.path);
  }
  const resolveLink = (target: string) => {
    const t = target.replace(/\.md$/i, "").toLowerCase();
    return byPath.get(t) ?? byBase.get(basename(t)) ?? null;
  };
  return { rows, resolveLink };
}
export function noteLinks(v: Row, rel: string) {
  const { rows, resolveLink } = resolver(v);
  const me = rows.find((r) => r.path === rel);
  const out = (me?.refs ?? []).map((t: string) => ({ target: t, path: resolveLink(t) }));
  const backlinks = rows.filter((r) => r.path !== rel && (r.refs as string[]).some((t) => resolveLink(t) === rel)).map((r) => ({ path: r.path, title: r.title }));
  return { links: out, backlinks };
}

const TYPE_CLUSTER: Record<string, string> = {
  project: "PROJECT", goal: "PROJECT", content: "MARKETING & BUSINESS", video: "MARKETING & BUSINESS", report: "MARKETING & BUSINESS", ads: "MARKETING & BUSINESS",
  conversation: "CONVERSATIONS", wiki: "WIKI", skill: "WIKI", fact: "FACTS", knowledge: "FACTS", reference: "REFERENCES", agent: "AGENTS",
  daily: "NHẬT KÝ", weekly: "NHẬT KÝ", monthly: "NHẬT KÝ", reminder: "KẾ HOẠCH", identity: "IDENTITY", lesson: "LEARNING", dashboard: "DASHBOARD",
};
/** Notes without a known `type:` take the cluster of their top folder (guides included). */
const FOLDER_CLUSTER: Record<string, string> = {
  "00 - Dashboard": "DASHBOARD", "01 - Daily Log": "NHẬT KÝ", "02 - Weekly Log": "NHẬT KÝ", "03 - Monthly Log": "NHẬT KÝ", "01 - Inbox": "INBOX",
  "02 - Identity": "IDENTITY", "03 - Work": "PROJECT", "04 - Future Log": "KẾ HOẠCH", "04 - Marketing Engine": "MARKETING & BUSINESS",
  "05 - Data Cache": "DATA", "05 - Knowledge": "FACTS", "06 - Life": "LIFE", "07 - Learning": "LEARNING", "08 - Thinking": "THINKING",
  "09 - Archive": "ARCHIVE", "10 - Wiki": "WIKI", agents: "AGENTS", assets: "ASSETS", attachments: "ASSETS",
};
export function clusterOf(r: Row) {
  const t = String(r.meta?.type ?? "").toLowerCase();
  if (TYPE_CLUSTER[t]) return TYPE_CLUSTER[t];
  if (!String(r.path).includes("/")) return "KHÁC";
  const top = String(r.path).split("/")[0];
  return FOLDER_CLUSTER[top] ?? top.replace(/^\d+\s*-\s*/, "").toUpperCase();
}
export function vaultGraph(v: Row) {
  const { rows, resolveLink } = resolver(v);
  const links: { source: string; target: string }[] = [];
  const seen = new Set<string>();
  const deg = new Map<string, number>();
  for (const r of rows) for (const t of r.refs as string[]) {
    const to = resolveLink(t);
    if (!to || to === r.path) continue;
    const k = r.path < to ? `${r.path}|${to}` : `${to}|${r.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    links.push({ source: r.path, target: to });
    deg.set(r.path, (deg.get(r.path) ?? 0) + 1);
    deg.set(to, (deg.get(to) ?? 0) + 1);
  }
  const counts = new Map<string, number>();
  const nodes = rows.map((r) => { const c = clusterOf(r); counts.set(c, (counts.get(c) ?? 0) + 1); return { id: r.path, title: r.title, cluster: c, degree: deg.get(r.path) ?? 0, mtime: r.mtime }; });
  const total = rows.length || 1;
  const clusters = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count, pct: Math.max(1, Math.round((count / total) * 100)) }));
  return { nodes, links, clusters, notes: rows.length, edges: links.length };
}
export function recentNotes(v: Row, limit = 30) {
  return q.all<Row>("SELECT path, title, folder, mtime FROM brain_note WHERE vault_id = ? ORDER BY mtime DESC LIMIT ?", v.id, limit);
}
