#!/usr/bin/env node
// taki-flow-save — save the clips a Flow Tool is showing straight from the page (Chrome Flow, via CDP).
// Flow custom Tools run in an iframe sandboxed WITHOUT allow-downloads, so their "TẢI VỀ" buttons are blocked
// by Chrome; the clips are already in the page as <video> elements (data:/blob:/https URLs). Saved in on-page
// order (= scene order in the SẢN XUẤT step) as scene_01.mp4, scene_02.mp4…
//   taki-flow-save --out <dir> [--prefix scene_] [--cdp http://127.0.0.1:9333]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const out = arg("--out");
const prefix = arg("--prefix", "scene_");
const cdp = arg("--cdp", `http://127.0.0.1:${process.env.FLOW_CDP_PORT ?? 9333}`);
if (!out) { console.error("Dùng: taki-flow-save --out <thư mục> [--prefix scene_]"); process.exit(2); }

const b = await chromium.connectOverCDP(cdp, { timeout: 15_000 });
try {
  const pages = b.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => p.url().includes("/tool/")) ?? pages.find((p) => p.url().includes("flow.google"));
  if (!page) throw new Error("Không thấy tab Flow Tool trong Chrome Flow");
  const clips = [];
  for (const f of page.frames()) {
    // Read each video as base64 inside the page (works for data:, blob: and same-origin URLs).
    const got = await f.evaluate(async () => {
      const toB64 = (buf) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
      const out = [];
      for (const v of document.querySelectorAll("video")) {
        const src = v.currentSrc || v.src || v.querySelector("source")?.src || "";
        if (!src) continue;
        try {
          if (src.startsWith("data:")) out.push({ src: src.slice(0, 40), b64: src.slice(src.indexOf(",") + 1) });
          else out.push({ src: src.slice(0, 80), b64: toB64(await (await fetch(src)).arrayBuffer()) });
        } catch (e) { out.push({ src: src.slice(0, 80), error: String(e) }); }
      }
      return out;
    }).catch(() => []);
    clips.push(...got);
  }
  if (!clips.length) throw new Error("Trang Tool chưa có video nào (đã ở bước SẢN XUẤT và các cảnh đã xong chưa?)");
  mkdirSync(out, { recursive: true });
  const saved = [];
  const seen = new Set();
  for (const c of clips) {
    if (c.error) { saved.push({ error: c.error, src: c.src }); continue; }
    const key = `${c.b64.length}:${c.b64.slice(-64)}`;
    if (seen.has(key)) continue; // same clip rendered twice (preview + list)
    seen.add(key);
    const file = join(out, `${prefix}${String(seen.size).padStart(2, "0")}.mp4`);
    const buf = Buffer.from(c.b64, "base64");
    writeFileSync(file, buf);
    saved.push({ file, bytes: buf.length });
  }
  console.log(JSON.stringify({ count: saved.filter((s) => s.file).length, clips: saved }, null, 2));
} finally {
  await b.close().catch(() => {});
}
