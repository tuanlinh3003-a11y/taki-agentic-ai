import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AppError } from "@dotaka/shared";

/**
 * Local Chrome profiles (every profile the CEO created), read from each browser's "Local State".
 * Claude in Chrome runs per profile, so the Flow agent must drive the profile that is logged into Flow.
 * A profile is identified at run time by opening a marker tab in it (see markerUrl) — no guessing by "Browser 1/2".
 */
export const CLAUDE_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
export const CLAUDE_EXTENSION_URL = `https://chromewebstore.google.com/detail/${CLAUDE_EXTENSION_ID}`;
export const FLOW_URL = "https://flow.google.com"; // skills đều mở Flow qua địa chỉ này (chuyển tới labs.google/fx/tools/flow)

type Channel = { key: string; name: string; dir: string; macApp: string; linuxBin: string };
function channels(): Channel[] {
  const h = homedir();
  if (platform() === "darwin") {
    const as = join(h, "Library/Application Support");
    return [
      { key: "chrome", name: "Google Chrome", dir: join(as, "Google/Chrome"), macApp: "Google Chrome", linuxBin: "" },
      { key: "chrome-beta", name: "Chrome Beta", dir: join(as, "Google/Chrome Beta"), macApp: "Google Chrome Beta", linuxBin: "" },
      { key: "chrome-canary", name: "Chrome Canary", dir: join(as, "Google/Chrome Canary"), macApp: "Google Chrome Canary", linuxBin: "" },
      { key: "chromium", name: "Chromium", dir: join(as, "Chromium"), macApp: "Chromium", linuxBin: "" },
    ];
  }
  const cfg = join(h, ".config");
  return [
    { key: "chrome", name: "Google Chrome", dir: join(cfg, "google-chrome"), macApp: "", linuxBin: "google-chrome" },
    { key: "chrome-beta", name: "Chrome Beta", dir: join(cfg, "google-chrome-beta"), macApp: "", linuxBin: "google-chrome-beta" },
    { key: "chromium", name: "Chromium", dir: join(cfg, "chromium"), macApp: "", linuxBin: "chromium" },
  ];
}

function hasClaudeExtension(profileDir: string) {
  const dir = join(profileDir, "Extensions", CLAUDE_EXTENSION_ID);
  if (existsSync(dir)) return true;
  // Unpacked / renamed builds: look for any extension whose manifest name mentions Claude.
  try {
    for (const id of readdirSync(join(profileDir, "Extensions"))) {
      for (const ver of readdirSync(join(profileDir, "Extensions", id))) {
        const m = join(profileDir, "Extensions", id, ver, "manifest.json");
        if (existsSync(m) && /claude/i.test(JSON.parse(readFileSync(m, "utf8")).name ?? "")) return true;
      }
    }
  } catch { /* no Extensions folder */ }
  return false;
}

export type ChromeProfile = {
  channel: string; channelName: string; dir: string; name: string; email: string | null; googleName: string | null;
  lastUsed: boolean; activeAt: number | null; claudeExtension: boolean; hasAvatar: boolean;
};

export function listChromeProfiles(): ChromeProfile[] {
  const out: ChromeProfile[] = [];
  for (const ch of channels()) {
    const ls = join(ch.dir, "Local State");
    if (!existsSync(ls)) continue;
    let state: any;
    try { state = JSON.parse(readFileSync(ls, "utf8")); } catch { continue; }
    const cache = state?.profile?.info_cache ?? {};
    for (const [dir, p] of Object.entries<any>(cache)) {
      const pdir = join(ch.dir, dir);
      if (!existsSync(pdir)) continue;
      out.push({
        channel: ch.key, channelName: ch.name, dir, name: p.name || dir, email: p.user_name || null, googleName: p.gaia_name || null,
        lastUsed: state?.profile?.last_used === dir, activeAt: p.active_time ? Math.round(p.active_time * 1000) : null,
        claudeExtension: hasClaudeExtension(pdir), hasAvatar: existsSync(join(pdir, "Google Profile Picture.png")),
      });
    }
  }
  // Profiles with Claude in Chrome first, then most recently used.
  return out.sort((a, b) => Number(b.claudeExtension) - Number(a.claudeExtension) || (b.activeAt ?? 0) - (a.activeAt ?? 0));
}

export function profileAvatarPath(channel: string, dir: string) {
  const ch = channels().find((c) => c.key === channel);
  if (!ch || dir.includes("..") || dir.includes("/")) return null;
  const p = join(ch.dir, dir, "Google Profile Picture.png");
  return existsSync(p) ? p : null;
}

/** Open a URL in a specific Chrome profile (Chrome hands off to the running instance if it is open). */
export function openInProfile(channel: string, dir: string, url: string) {
  const ch = channels().find((c) => c.key === channel);
  if (!ch) throw new AppError("NO_BROWSER", "Không thấy trình duyệt này trên máy");
  if (!listChromeProfiles().some((p) => p.channel === channel && p.dir === dir)) throw new AppError("NO_PROFILE", "Không thấy profile Chrome này");
  if (!/^https?:\/\//.test(url)) throw new AppError("INVALID", "URL không hợp lệ");
  const [cmd, args] = platform() === "darwin"
    ? ["open", ["-na", ch.macApp, "--args", `--profile-directory=${dir}`, url]]
    : [ch.linuxBin, [`--profile-directory=${dir}`, url]];
  const p = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
  p.on("error", () => { /* reported to the caller via the UI hint */ });
  p.unref();
}

/** A local page whose <title> lets the agent find the exact browser/profile among connected ones. */
export const markerTitle = (token: string) => `TAKI-FLOW-${token}`;
export const markerUrl = (token: string) => `http://127.0.0.1:${process.env.API_PORT ?? 8787}/v1/creative/marker/${encodeURIComponent(token)}`;
