import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@dotaka/shared";

/**
 * Claude Code CLI provider: runs `claude -p` headless with the CEO's logged-in account
 * (Pro/Max/Team subscription). No API key involved — we even strip ANTHROPIC_API_KEY from the
 * child env so the CLI never silently switches to API billing.
 * Each call: no tools, no session persistence, no project/user settings, JSON-schema output.
 */
const BIN = process.env.CLAUDE_CLI_PATH ?? "claude";
const MAX_PARALLEL = Number(process.env.CLAUDE_CLI_CONCURRENCY ?? 2);
const TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 240_000);
const WORKDIR = join(tmpdir(), "dotaka-claude-cli");

let info: { available: boolean; version?: string; checkedAt: number } | null = null;
export function cliInfo() {
  if (!info || Date.now() - info.checkedAt > 60_000) {
    try {
      const v = execFileSync(BIN, ["--version"], { encoding: "utf8", timeout: 10_000, env: childEnv() }).trim();
      info = { available: true, version: v, checkedAt: Date.now() };
    } catch {
      info = { available: false, checkedAt: Date.now() };
    }
  }
  return { ...info, bin: BIN };
}
export const cliAvailable = () => cliInfo().available;

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // force the subscription login, never API billing
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDECODE; // allow running even when the server itself was started from Claude Code
  return env;
}

// Simple semaphore: CLI calls are heavy processes; keep a few at a time.
let active = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

export interface CliResult {
  structured: unknown;
  model: string;
  usage: { input: number; output: number; cached: number };
  costMicros: number;
  durationMs: number;
}

export function runClaudeCli(opts: { prompt: string; system: string; model: string; jsonSchema: object; effort?: string }): Promise<CliResult> {
  return slot(() => new Promise<CliResult>((resolve, reject) => {
    mkdirSync(WORKDIR, { recursive: true });
    const args = [
      "-p", "--output-format", "json", "--model", opts.model,
      "--system-prompt", opts.system,
      "--json-schema", JSON.stringify(opts.jsonSchema),
      "--tools", "", "--no-session-persistence", "--setting-sources", "",
    ];
    if (opts.effort && !opts.model.includes("haiku")) args.push("--effort", opts.effort);
    const child = spawn(BIN, args, { cwd: WORKDIR, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new AppError("CLI_TIMEOUT", `Claude CLI quá ${Math.round(TIMEOUT_MS / 1000)} giây`, 504));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new AppError("CLI_NOT_FOUND", `Không chạy được Claude CLI: ${e.message}`, 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let j: any;
      try {
        j = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
      } catch {
        return reject(new AppError("CLI_BAD_OUTPUT", `Claude CLI trả về không phải JSON (code ${code}): ${(err || out).slice(0, 400)}`, 502));
      }
      if (j.is_error || j.subtype !== "success") {
        const msg = String(j.result ?? j.api_error_status ?? err ?? "lỗi không rõ").slice(0, 400);
        const code2 = /login|auth|credential|not logged/i.test(msg) ? "CLI_NOT_LOGGED_IN" : /limit|quota|usage/i.test(msg) ? "CLI_USAGE_LIMIT" : "CLI_ERROR";
        return reject(new AppError(code2, `Claude CLI: ${msg}`, 502));
      }
      const mu = Object.entries(j.modelUsage ?? {}) as [string, any][];
      const main = mu.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0];
      const u = j.usage ?? {};
      resolve({
        structured: j.structured_output ?? safeJson(j.result),
        model: main?.[1]?.canonicalModel ?? main?.[0] ?? opts.model,
        usage: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0 },
        costMicros: Math.round((j.total_cost_usd ?? 0) * 1e6),
        durationMs: j.duration_ms ?? 0,
      });
    });
    child.stdin.end(opts.prompt);
  }));
}

function safeJson(s: unknown) {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
}

// ---------------- Long-running tool-using agent (browser automation) ----------------
export interface AgentRunOptions {
  prompt: string;
  system: string;
  model: string;
  jsonSchema: object;
  allowedTools: string[];
  addDirs: string[];
  cwd: string;
  chrome?: boolean;
  timeoutMs?: number;
  /** Called for each tool call / text step so the UI can show live progress. */
  onStep?: (step: { at: string; kind: "tool" | "text"; text: string }) => void;
  signal?: AbortSignal;
}
export interface AgentRunResult {
  structured: unknown;
  model: string;
  usage: { input: number; output: number; cached: number };
  costMicros: number;
  durationMs: number;
  turns: number;
  denials: unknown[];
}

function describeTool(name: string, input: any): string {
  const short = name.replace(/^mcp__claude-in-chrome__/, "chrome.");
  if (input?.url) return `${short} ${input.url}`;
  if (input?.command) return `${short}: ${String(input.command).slice(0, 140)}`;
  if (input?.action) return `${short} ${input.action}${input.text ? ` "${String(input.text).slice(0, 60)}"` : ""}`;
  if (input?.query) return `${short} "${String(input.query).slice(0, 60)}"`;
  return short;
}

/** Runs `claude -p` with tools (and optionally Claude in Chrome) until it returns schema-shaped JSON. */
export function runClaudeAgent(o: AgentRunOptions): Promise<AgentRunResult> {
  return new Promise<AgentRunResult>((resolve, reject) => {
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--model", o.model,
      "--append-system-prompt", o.system,
      "--json-schema", JSON.stringify(o.jsonSchema),
      "--permission-mode", "dontAsk",
      "--allowedTools", ...o.allowedTools,
      "--no-session-persistence", "--setting-sources", "",
      ...(o.chrome ? ["--chrome"] : ["--no-chrome"]),
      ...o.addDirs.flatMap((d) => ["--add-dir", d]),
    ];
    const child = spawn(BIN, args, { cwd: o.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    let final: any = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new AppError("AGENT_TIMEOUT", `Agent chạy quá ${Math.round((o.timeoutMs ?? 0) / 60000)} phút`, 504));
    }, o.timeoutMs ?? 75 * 60_000);
    o.signal?.addEventListener("abort", () => { child.kill("SIGTERM"); reject(new AppError("CANCELLED", "Đã hủy", 499)); });
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "assistant") {
          for (const c of ev.message?.content ?? []) {
            if (c.type === "tool_use") o.onStep?.({ at: new Date().toISOString(), kind: "tool", text: describeTool(c.name, c.input) });
            else if (c.type === "text" && c.text?.trim()) o.onStep?.({ at: new Date().toISOString(), kind: "text", text: c.text.trim().slice(0, 300) });
          }
        } else if (ev.type === "result") final = ev;
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new AppError("CLI_NOT_FOUND", `Không chạy được Claude CLI: ${e.message}`, 503)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!final) return reject(new AppError("CLI_BAD_OUTPUT", `Agent dừng không có kết quả (code ${code}): ${err.slice(-400)}`, 502));
      if (final.is_error || final.subtype !== "success") return reject(new AppError("AGENT_ERROR", `Agent lỗi: ${String(final.result ?? final.subtype).slice(0, 400)}`, 502));
      const mu = Object.entries(final.modelUsage ?? {}) as [string, any][];
      const main = mu.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0];
      const u = final.usage ?? {};
      resolve({
        structured: final.structured_output ?? safeJson(final.result),
        model: main?.[1]?.canonicalModel ?? main?.[0] ?? o.model,
        usage: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0 },
        costMicros: Math.round((final.total_cost_usd ?? 0) * 1e6),
        durationMs: final.duration_ms ?? 0,
        turns: final.num_turns ?? 0,
        denials: final.permission_denials ?? [],
      });
    });
    child.stdin.end(o.prompt);
  });
}

// ---------------- Supervised run in a Terminal window (Claude in Chrome needs a human to approve) ----------------
export interface TerminalRunOptions {
  title: string;
  prompt: string;
  system: string;
  model: string;
  cwd: string;
  allowedTools: string[];
  addDirs: string[];
  /** The agent writes its final JSON here; the run completes when this file appears and parses. */
  resultFile: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onStep?: (step: { at: string; kind: "tool" | "text"; text: string }) => void;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Claude Code (2.1.2xx+) refuses Claude in Chrome actions in headless `-p` runs unless a person approves them.
 * So browser jobs run as an INTERACTIVE Claude session in a Terminal window: the CEO approves Chrome once
 * ("allow for this session"), the agent works, writes `resultFile`, and we pick it up. Progress is read live
 * from the session transcript (~/.claude/projects/<cwd>/<session-id>.jsonl).
 */
export async function runClaudeInTerminal(o: TerminalRunOptions): Promise<unknown> {
  if (process.platform !== "darwin") throw new AppError("NOT_SUPPORTED", "Chế độ Terminal hiện hỗ trợ macOS");
  const { writeFileSync, existsSync, readFileSync, rmSync, chmodSync, readdirSync, statSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { randomUUID } = await import("node:crypto");
  const dir = join(o.cwd, ".taki-run");
  mkdirSync(dir, { recursive: true });
  rmSync(o.resultFile, { force: true });
  const sessionId = randomUUID();
  // Absolute path: a Terminal login shell may not have the same PATH as this server.
  let bin = BIN;
  try { bin = execFileSync("/bin/sh", ["-lc", `command -v ${shq(BIN)}`], { encoding: "utf8", env: childEnv() }).trim() || BIN; } catch { /* keep BIN */ }
  writeFileSync(join(dir, "system.md"), o.system);
  writeFileSync(join(dir, "prompt.md"), o.prompt);
  const script = join(dir, "run.command");
  writeFileSync(script, [
    "#!/bin/bash",
    `cd ${shq(o.cwd)}`,
    `printf '\\033]0;TAKI · ${o.title.replace(/'/g, "")}\\007'`,
    "clear",
    `echo "TAKI Agentic AI — ${o.title.replace(/["$`\\]/g, "")}"`,
    'echo "Khi Claude hỏi quyền dùng Chrome/trang web: chọn cho phép (trong phiên này)."',
    'echo "Để cửa sổ này mở đến khi Claude báo XONG. Hệ thống tự nhận kết quả."',
    "echo",
    "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDECODE",
    `exec ${shq(bin)} --chrome --model ${shq(o.model)} --session-id ${sessionId} --name ${shq(`TAKI · ${o.title}`)} \\`,
    `  --allowedTools ${o.allowedTools.map(shq).join(" ")} \\`,
    ...o.addDirs.map((d) => `  --add-dir ${shq(d)} \\`),
    `  --append-system-prompt-file ${shq(join(dir, "system.md"))} \\`,
    `  "$(cat ${shq(join(dir, "prompt.md"))})"`,
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  await new Promise<void>((resolve, reject) => {
    const p = spawn("open", ["-a", "Terminal", script], { stdio: "ignore" });
    p.on("error", (e) => reject(new AppError("TERMINAL_FAILED", `Không mở được Terminal: ${e.message}`, 503)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new AppError("TERMINAL_FAILED", `Không mở được Terminal (code ${code})`, 503))));
  });

  // Live progress from the transcript of this session.
  const projects = join(homedir(), ".claude", "projects");
  let transcript: string | null = null;
  let offset = 0;
  const readSteps = () => {
    if (!transcript) {
      try {
        for (const d of readdirSync(projects)) {
          const f = join(projects, d, `${sessionId}.jsonl`);
          if (existsSync(f)) { transcript = f; break; }
        }
      } catch { /* not created yet */ }
      if (!transcript) return;
    }
    const size = statSync(transcript).size;
    if (size <= offset) return;
    const chunk = readFileSync(transcript, "utf8").slice(offset);
    offset = size;
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== "assistant") continue;
      for (const c of ev.message?.content ?? []) {
        if (c.type === "tool_use") o.onStep?.({ at: new Date().toISOString(), kind: "tool", text: describeTool(c.name, c.input) });
        else if (c.type === "text" && c.text?.trim()) o.onStep?.({ at: new Date().toISOString(), kind: "text", text: c.text.trim().slice(0, 300) });
      }
    }
  };

  const started = Date.now();
  o.onStep?.({ at: new Date().toISOString(), kind: "text", text: "Đã mở cửa sổ Terminal — bấm cho phép Claude dùng Chrome khi được hỏi" });
  while (true) {
    if (o.signal?.aborted) throw new AppError("CANCELLED", "Đã hủy", 499);
    if (Date.now() - started > o.timeoutMs) throw new AppError("AGENT_TIMEOUT", `Quá ${Math.round(o.timeoutMs / 60000)} phút chưa có kết quả`, 504);
    try { readSteps(); } catch { /* transcript mid-write */ }
    if (existsSync(o.resultFile)) {
      try { return JSON.parse(readFileSync(o.resultFile, "utf8")); } catch { /* still being written */ }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
