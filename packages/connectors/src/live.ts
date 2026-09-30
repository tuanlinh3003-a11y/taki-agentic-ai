import { createSign } from "node:crypto";
import type { CanonicalMetrics } from "@dotaka/contracts";
import { ConnectorError, type AdRef, type Connector, type ImportedAd } from "./index.ts";

/**
 * Live platform adapters. Each takes decrypted credentials (never logged) and speaks the
 * platform's public API. Errors are mapped to ConnectorError kinds so the queue can decide
 * retry (Transient/RateLimited) vs. dead-letter (Auth/InvalidRequest/PolicyRejected).
 */
const TIMEOUT = 25_000;

async function http(url: string, init: RequestInit & { label: string }): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new ConnectorError("Transient", `${init.label}: không kết nối được (${e instanceof Error ? e.message : e})`);
  }
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  if (res.status === 429) throw new ConnectorError("RateLimited", `${init.label}: bị giới hạn tần suất, thử lại sau`);
  if (res.status >= 500) throw new ConnectorError("Transient", `${init.label}: lỗi máy chủ ${res.status}`);
  if (!res.ok) {
    const msg = body?.error?.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? body?.error_description ?? body?.message ?? body?.description ?? String(text).slice(0, 200);
    throw new ConnectorError(res.status === 401 || res.status === 403 ? "AuthError" : "InvalidRequest", `${init.label}: ${msg}`);
  }
  return body;
}

/** Currencies without minor units: Meta/TikTok budgets are sent in whole units. */
const ZERO_DECIMAL = new Set(["VND", "JPY", "KRW", "CLP", "ISK", "PYG", "TWD", "HUF", "IDR", "COP"]);
export const minorFactor = (cur = "VND") => (ZERO_DECIMAL.has(cur.toUpperCase()) ? 1 : 100);

// =====================================================================================
// Meta (Graph API)
// =====================================================================================
const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION ?? "v23.0"}`;
const RESULT_ACTIONS: Record<string, string[]> = {
  messaging: ["onsite_conversion.messaging_conversation_started_7d"],
  lead: ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"],
  purchase: ["purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase"],
  link_click: ["link_click"],
};

export type MetaCreds = { access_token: string };
async function graph(token: string, path: string, params: Record<string, unknown> = {}, method: "GET" | "POST" = "GET") {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, typeof v === "string" ? v : JSON.stringify(v));
  qs.set("access_token", token);
  if (method === "GET") return http(`${GRAPH()}/${path}?${qs}`, { label: "Meta", method });
  return http(`${GRAPH()}/${path}`, { label: "Meta", method, body: qs, headers: { "content-type": "application/x-www-form-urlencoded" } });
}
async function graphAll(token: string, path: string, params: Record<string, unknown>, maxPages = 10): Promise<any[]> {
  const out: any[] = [];
  let r = await graph(token, path, params);
  for (let i = 0; i < maxPages; i++) {
    out.push(...(r.data ?? []));
    if (!r.paging?.next) break;
    r = await http(r.paging.next, { label: "Meta" });
  }
  return out;
}

export async function metaTest(c: MetaCreds) {
  const me = await graph(c.access_token, "me", { fields: "id,name" });
  return { accountId: String(me.id), name: String(me.name ?? me.id) };
}
export async function metaDiscover(c: MetaCreds) {
  const [adAccounts, pages] = await Promise.all([
    graphAll(c.access_token, "me/adaccounts", { fields: "id,name,currency,account_status,business_name", limit: 200 }),
    graphAll(c.access_token, "me/accounts", { fields: "id,name,category,access_token", limit: 200 }).catch(() => []),
  ]);
  return {
    adAccounts: adAccounts.map((a) => ({ externalId: String(a.id), name: String(a.name ?? a.id), currency: String(a.currency ?? "VND"), active: a.account_status === 1, business: a.business_name ?? null })),
    pages: pages.map((p) => ({ externalId: String(p.id), name: String(p.name), category: p.category ?? null, token: p.access_token as string | undefined })),
  };
}
export async function metaPagePosts(pageId: string, pageToken: string, limit = 25) {
  const r = await graph(pageToken, `${pageId}/posts`, { fields: "id,message,created_time,full_picture,permalink_url,status_type", limit });
  return (r.data ?? []).map((p: any) => ({ externalId: String(p.id), text: String(p.message ?? "(không có chữ)"), createdAt: p.created_time, image: p.full_picture ?? null, permalink: p.permalink_url ?? null, kind: p.status_type ?? "post" }));
}

function metaResults(actions: { action_type: string; value: string }[] | undefined, resultAction: string) {
  const want = RESULT_ACTIONS[resultAction] ?? RESULT_ACTIONS.messaging;
  for (const t of want) {
    const hit = actions?.find((a) => a.action_type === t);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

export function metaConnector(c: MetaCreds, config: { result_action?: string }): Connector {
  const resultAction = config.result_action ?? "messaging";
  const toMetrics = (r: any): CanonicalMetrics => ({
    spend: Math.round(Number(r.spend ?? 0)), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0),
    results: metaResults(r.actions, resultAction), reach: Number(r.reach ?? 0),
  });
  return {
    platform: "meta", mode: "live", limits: { requestsPerMinute: 60, concurrency: 2 },
    async health() {
      const me = await metaTest(c);
      return { ok: true, detail: `Token hợp lệ (${me.name})` };
    },
    async fetchAdMetrics(ad: AdRef, day: string) {
      const r = await graph(c.access_token, `${ad.externalId}/insights`, { fields: "spend,impressions,clicks,reach,actions", time_range: { since: day, until: day } });
      return r.data?.[0] ? toMetrics(r.data[0]) : { spend: 0, impressions: 0, clicks: 0, results: 0, reach: 0 };
    },
    async fetchAccountMetrics(accountExternalId, since, until) {
      const rows = await graphAll(c.access_token, `${accountExternalId}/insights`, {
        level: "ad", fields: "ad_id,spend,impressions,clicks,reach,actions", time_range: { since, until }, time_increment: 1, limit: 500,
      }, 20);
      return rows.map((r) => ({ adExternalId: String(r.ad_id), day: String(r.date_start), metrics: toMetrics(r) }));
    },
    async listAds(accountExternalId, currency = "VND") {
      const f = minorFactor(currency);
      const rows = await graphAll(c.access_token, `${accountExternalId}/ads`, {
        fields: "id,name,effective_status,adset{id,name,daily_budget},campaign{id,name,objective,daily_budget,effective_status}",
        filtering: [{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"] }], limit: 200,
      });
      return rows.map((a): ImportedAd => {
        const adsetBudget = a.adset?.daily_budget ? Number(a.adset.daily_budget) / f : null;
        const cmpBudget = a.campaign?.daily_budget ? Number(a.campaign.daily_budget) / f : null;
        return {
          externalId: String(a.id), name: String(a.name), status: a.effective_status === "ACTIVE" ? "active" : "paused",
          dailyBudget: adsetBudget ?? cmpBudget,
          meta: { adsetId: a.adset?.id, budgetOwner: adsetBudget != null ? "adset" : cmpBudget != null ? "campaign" : null, budgetOwnerId: adsetBudget != null ? a.adset?.id : a.campaign?.id, currency },
          campaign: { externalId: String(a.campaign?.id ?? "unknown"), name: String(a.campaign?.name ?? "Chiến dịch"), objective: String(a.campaign?.objective ?? "unknown"), status: a.campaign?.effective_status === "ACTIVE" ? "active" : "paused", dailyBudget: cmpBudget },
        };
      });
    },
    async updateStatus(ad, status) {
      await graph(c.access_token, ad.externalId, { status: status === "active" ? "ACTIVE" : "PAUSED" }, "POST");
      return { ok: true };
    },
    async updateBudget(ad, amount) {
      const owner = ad.meta?.budgetOwnerId;
      if (!owner) throw new ConnectorError("InvalidRequest", "Quảng cáo này không có ngân sách ngày ở nhóm/chiến dịch (có thể dùng ngân sách trọn đời)");
      await graph(c.access_token, owner, { daily_budget: String(Math.round(amount * minorFactor(ad.meta?.currency))) }, "POST");
      return { ok: true };
    },
    async createAdFromPost(spec) {
      const act = spec.accountExternalId;
      if (!act || !spec.pageExternalId) throw new ConnectorError("InvalidRequest", "Thiếu tài khoản quảng cáo hoặc Fanpage");
      const t = (spec.template ?? {}) as any;
      const status = spec.startPaused ? "PAUSED" : "ACTIVE";
      const objective = t.objective ?? "messages";
      const goal = objective === "traffic" ? { campaign: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS" }
        : objective === "engagement" ? { campaign: "OUTCOME_ENGAGEMENT", optimization_goal: "POST_ENGAGEMENT", destination_type: "ON_POST" }
        : { campaign: "OUTCOME_ENGAGEMENT", optimization_goal: "CONVERSATIONS", destination_type: "MESSENGER" };
      const aud = t.audience ?? {};
      const cmp = await graph(c.access_token, `${act}/campaigns`, { name: spec.name, objective: goal.campaign, status, special_ad_categories: [], is_adset_budget_sharing_enabled: false }, "POST");
      const adset = await graph(c.access_token, `${act}/adsets`, {
        name: spec.name, campaign_id: cmp.id, status, billing_event: "IMPRESSIONS", optimization_goal: goal.optimization_goal,
        ...(goal.destination_type ? { destination_type: goal.destination_type } : {}),
        bid_strategy: "LOWEST_COST_WITHOUT_CAP", daily_budget: String(Math.round(spec.dailyBudget * minorFactor(spec.currency))),
        promoted_object: { page_id: spec.pageExternalId },
        targeting: { geo_locations: { countries: aud.locations?.length ? aud.locations : ["VN"] }, age_min: aud.ageMin ?? 18, age_max: aud.ageMax ?? 65, ...(aud.genders?.length ? { genders: aud.genders } : {}), targeting_automation: { advantage_audience: 1 } },
      }, "POST");
      const storyId = spec.postExternalId.includes("_") ? spec.postExternalId : `${spec.pageExternalId}_${spec.postExternalId}`;
      const creative = await graph(c.access_token, `${act}/adcreatives`, { name: spec.name, object_story_id: storyId }, "POST");
      const ad = await graph(c.access_token, `${act}/ads`, { name: spec.name, adset_id: adset.id, creative: { creative_id: creative.id }, status }, "POST");
      return { externalId: String(ad.id), campaignExternalId: String(cmp.id), meta: { adsetId: adset.id, budgetOwner: "adset", budgetOwnerId: adset.id, currency: spec.currency ?? "VND" } };
    },
  };
}

// =====================================================================================
// TikTok Business API v1.3
// =====================================================================================
const TT = "https://business-api.tiktok.com/open_api/v1.3";
export type TikTokCreds = { access_token: string };
async function tt(token: string, path: string, params: Record<string, unknown> = {}, method: "GET" | "POST" = "GET") {
  let r: any;
  if (method === "GET") {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    r = await http(`${TT}${path}?${qs}`, { label: "TikTok", headers: { "Access-Token": token } });
  } else {
    r = await http(`${TT}${path}`, { label: "TikTok", method, headers: { "Access-Token": token, "content-type": "application/json" }, body: JSON.stringify(params) });
  }
  if (r?.code !== 0) throw new ConnectorError(r?.code === 40105 || r?.code === 40100 ? "AuthError" : "InvalidRequest", `TikTok: ${r?.message ?? "lỗi không rõ"} (code ${r?.code})`);
  return r.data;
}
export async function tiktokTest(c: TikTokCreds, advertiserIds: string[]) {
  const info = await tt(c.access_token, "/advertiser/info/", { advertiser_ids: advertiserIds });
  const list = (info?.list ?? []) as any[];
  if (!list.length) throw new ConnectorError("AuthError", "TikTok: token không có quyền với Advertiser ID đã nhập");
  return list.map((a) => ({ externalId: String(a.advertiser_id), name: String(a.name ?? a.advertiser_id), currency: String(a.currency ?? "VND"), active: String(a.status ?? "").includes("ENABLE") }));
}
export function tiktokConnector(c: TikTokCreds): Connector {
  const toMetrics = (m: any): CanonicalMetrics => ({ spend: Math.round(Number(m.spend ?? 0)), impressions: Number(m.impressions ?? 0), clicks: Number(m.clicks ?? 0), results: Number(m.conversion ?? 0), reach: Number(m.reach ?? 0) });
  const advertiserOf = (ad: AdRef) => {
    if (!ad.accountExternalId) throw new ConnectorError("InvalidRequest", "Thiếu advertiser_id");
    return ad.accountExternalId;
  };
  return {
    platform: "tiktok", mode: "live", limits: { requestsPerMinute: 30, concurrency: 2 },
    async health() {
      await tt(c.access_token, "/user/info/");
      return { ok: true, detail: "Token TikTok hợp lệ" };
    },
    async fetchAccountMetrics(advertiserId, since, until) {
      const out: { adExternalId: string; day: string; metrics: CanonicalMetrics }[] = [];
      for (let page = 1; page <= 20; page++) {
        const d = await tt(c.access_token, "/report/integrated/get/", {
          advertiser_id: advertiserId, report_type: "BASIC", data_level: "AUCTION_AD", dimensions: ["ad_id", "stat_time_day"],
          metrics: ["spend", "impressions", "clicks", "reach", "conversion"], start_date: since, end_date: until, page, page_size: 1000,
        });
        for (const r of d?.list ?? []) out.push({ adExternalId: String(r.dimensions.ad_id), day: String(r.dimensions.stat_time_day).slice(0, 10), metrics: toMetrics(r.metrics) });
        if (page >= (d?.page_info?.total_page ?? 1)) break;
      }
      return out;
    },
    async listAds(advertiserId) {
      const fetchAll = async (path: string, fields: string[]) => {
        const out: any[] = [];
        for (let page = 1; page <= 20; page++) {
          const d = await tt(c.access_token, path, { advertiser_id: advertiserId, fields, page, page_size: 1000 });
          out.push(...(d?.list ?? []));
          if (page >= (d?.page_info?.total_page ?? 1)) break;
        }
        return out;
      };
      const [cmps, groups, ads] = await Promise.all([
        fetchAll("/campaign/get/", ["campaign_id", "campaign_name", "objective_type", "budget", "budget_mode", "operation_status"]),
        fetchAll("/adgroup/get/", ["adgroup_id", "campaign_id", "budget", "budget_mode"]),
        fetchAll("/ad/get/", ["ad_id", "ad_name", "adgroup_id", "campaign_id", "operation_status"]),
      ]);
      const cm = new Map(cmps.map((x) => [String(x.campaign_id), x]));
      const gm = new Map(groups.map((x) => [String(x.adgroup_id), x]));
      return ads.map((a): ImportedAd => {
        const g = gm.get(String(a.adgroup_id));
        const cp = cm.get(String(a.campaign_id));
        const daily = g?.budget_mode === "BUDGET_MODE_DAY" ? Number(g.budget) : null;
        return {
          externalId: String(a.ad_id), name: String(a.ad_name), status: a.operation_status === "ENABLE" ? "active" : "paused", dailyBudget: daily,
          meta: { adgroupId: a.adgroup_id, budgetOwner: daily != null ? "adgroup" : null, budgetOwnerId: daily != null ? String(a.adgroup_id) : null },
          campaign: { externalId: String(a.campaign_id), name: String(cp?.campaign_name ?? "Chiến dịch"), objective: String(cp?.objective_type ?? "unknown"), status: cp?.operation_status === "ENABLE" ? "active" : "paused", dailyBudget: cp?.budget_mode === "BUDGET_MODE_DAY" ? Number(cp.budget) : null },
        };
      });
    },
    async updateStatus(ad, status) {
      await tt(c.access_token, "/ad/status/update/", { advertiser_id: advertiserOf(ad), ad_ids: [ad.externalId], operation_status: status === "active" ? "ENABLE" : "DISABLE" }, "POST");
      return { ok: true };
    },
    async updateBudget(ad, amount) {
      if (!ad.meta?.budgetOwnerId) throw new ConnectorError("InvalidRequest", "Nhóm quảng cáo không dùng ngân sách ngày");
      await tt(c.access_token, "/adgroup/budget/update/", { advertiser_id: advertiserOf(ad), budget: [{ adgroup_id: ad.meta.budgetOwnerId, budget: amount }] }, "POST");
      return { ok: true };
    },
  };
}

// =====================================================================================
// Google Sheets (service account, JWT bearer)
// =====================================================================================
export type SheetsCreds = { service_account_json: string };
const tokenCache = new Map<string, { token: string; exp: number }>();
function parseSa(json: string) {
  let sa: any;
  try { sa = JSON.parse(json); } catch { throw new ConnectorError("InvalidRequest", "Service account JSON không hợp lệ"); }
  if (!sa.client_email || !sa.private_key) throw new ConnectorError("InvalidRequest", "JSON thiếu client_email/private_key");
  return sa as { client_email: string; private_key: string };
}
async function sheetsToken(c: SheetsCreds) {
  const sa = parseSa(c.service_account_json);
  const hit = tokenCache.get(sa.client_email);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r = await http("https://oauth2.googleapis.com/token", {
    label: "Google", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  tokenCache.set(sa.client_email, { token: r.access_token, exp: Date.now() + (r.expires_in ?? 3600) * 1000 });
  return r.access_token as string;
}
export const spreadsheetIdOf = (urlOrId: string) => urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? urlOrId.trim();

export async function sheetsTest(c: SheetsCreds, spreadsheet?: string) {
  const sa = parseSa(c.service_account_json);
  const token = await sheetsToken(c);
  if (!spreadsheet) return { accountId: sa.client_email, name: sa.client_email, title: null as string | null };
  const r = await http(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetIdOf(spreadsheet)}?fields=properties.title`, { label: "Google Sheets", headers: { authorization: `Bearer ${token}` } });
  return { accountId: sa.client_email, name: sa.client_email, title: r.properties?.title as string };
}
export async function sheetsWrite(c: SheetsCreds, spreadsheet: string, tab: string, rows: (string | number | null)[][], mode: "overwrite" | "append") {
  const token = await sheetsToken(c);
  const id = spreadsheetIdOf(spreadsheet);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const meta = await http(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties.title`, { label: "Google Sheets", headers: auth });
  if (!(meta.sheets ?? []).some((s: any) => s.properties?.title === tab)) {
    await http(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, { label: "Google Sheets", method: "POST", headers: auth, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
  }
  const range = encodeURIComponent(`'${tab}'!A1`);
  if (mode === "overwrite") {
    await http(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${tab}'`)}:clear`, { label: "Google Sheets", method: "POST", headers: auth, body: "{}" });
    await http(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueInputOption=USER_ENTERED`, { label: "Google Sheets", method: "PUT", headers: auth, body: JSON.stringify({ values: rows }) });
  } else {
    await http(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { label: "Google Sheets", method: "POST", headers: auth, body: JSON.stringify({ values: rows }) });
  }
  return { title: meta.properties?.title as string, url: `https://docs.google.com/spreadsheets/d/${id}` };
}

// =====================================================================================
// Telegram
// =====================================================================================
export type TelegramCreds = { bot_token: string };
export async function telegramTest(c: TelegramCreds, chatId?: string) {
  const me = await http(`https://api.telegram.org/bot${c.bot_token}/getMe`, { label: "Telegram" });
  let chat: string | null = null;
  if (chatId) {
    const r = await http(`https://api.telegram.org/bot${c.bot_token}/getChat?chat_id=${encodeURIComponent(chatId)}`, { label: "Telegram" });
    chat = r.result?.title ?? r.result?.username ?? r.result?.first_name ?? chatId;
  }
  return { accountId: String(me.result.id), name: `@${me.result.username}`, chat };
}
export async function telegramSend(c: TelegramCreds, chatId: string, text: string) {
  await http(`https://api.telegram.org/bot${c.bot_token}/sendMessage`, { label: "Telegram", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
}

// =====================================================================================
// Pancake POS
// =====================================================================================
const POS = "https://pos.pages.fm/api/v1";
export type PancakeCreds = { api_key: string };
export async function pancakeTest(c: PancakeCreds) {
  const r = await http(`${POS}/shops?api_key=${encodeURIComponent(c.api_key)}`, { label: "Pancake POS" });
  const shops = (r.shops ?? r.data ?? []) as any[];
  if (r.success === false) throw new ConnectorError("AuthError", `Pancake POS: ${r.message ?? "API key không hợp lệ"}`);
  return shops.map((s) => ({ externalId: String(s.id), name: String(s.name ?? s.id) }));
}
export async function pancakeOrders(c: PancakeCreds, shopId: string, limit = 30) {
  const r = await http(`${POS}/shops/${shopId}/orders?api_key=${encodeURIComponent(c.api_key)}&page_size=${limit}&page_number=1`, { label: "Pancake POS" });
  return ((r.data ?? []) as any[]).map((o) => ({ id: String(o.id), customer: o.bill_full_name ?? o.customer?.name ?? null, total: Number(o.total_price ?? o.total ?? 0), status: o.status_name ?? o.status, createdAt: o.inserted_at ?? o.created_at }));
}

// =====================================================================================
// Nhanh.vn (API v2.0, form-encoded)
// =====================================================================================
export type NhanhCreds = { app_id: string; business_id: string; access_token: string };
async function nhanh(c: NhanhCreds, path: string, data: unknown) {
  const base = process.env.NHANH_API_BASE ?? "https://open.nhanh.vn/api";
  const r = await http(`${base}${path}`, {
    label: "Nhanh.vn", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ version: "2.0", appId: c.app_id, businessId: c.business_id, accessToken: c.access_token, data: JSON.stringify(data) }),
  });
  if (r?.code !== 1) throw new ConnectorError("AuthError", `Nhanh.vn: ${(r?.messages ?? []).join?.(", ") || r?.message || "lỗi không rõ"}`);
  return r.data;
}
export async function nhanhTest(c: NhanhCreds) {
  const d = await nhanh(c, "/order/index", { page: 1, icpp: 1 });
  return { accountId: c.business_id, name: `Doanh nghiệp ${c.business_id}`, totalOrders: Number(d?.totalRecords ?? 0) };
}
export async function nhanhOrders(c: NhanhCreds, limit = 30) {
  const d = await nhanh(c, "/order/index", { page: 1, icpp: limit });
  return Object.values(d?.orders ?? {}).map((o: any) => ({ id: String(o.id), customer: o.customerName ?? null, total: Number(o.calcTotalMoney ?? o.totalMoney ?? 0), status: o.statusName ?? o.statusCode, createdAt: o.createdDateTime }));
}

// =====================================================================================
// ZL-CRM (github.com/nguyentatkiem/ZL-CRM) — Public API, header X-Api-Key
// =====================================================================================
export type ZlCreds = { base_url: string; api_key: string };
async function zl(c: ZlCreds, path: string, init: RequestInit = {}) {
  const base = (c.base_url ?? "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
  if (!/^https?:\/\//.test(base)) throw new ConnectorError("InvalidRequest", "ZL-CRM: địa chỉ phải bắt đầu bằng http:// hoặc https://");
  return http(`${base}${path}`, { ...init, label: "ZL-CRM", headers: { "x-api-key": c.api_key, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
}
export type ZlAccount = { id: string; displayName: string; status: string };
export type ZlConversation = {
  id: string; threadType: "user" | "group"; externalThreadId: string | null; lastMessageAt: string | null; unreadCount: number; isReplied: boolean;
  zaloAccountId?: string; zaloAccount?: { id: string; displayName: string };
  contact: { id: string; fullName: string | null; phone: string | null } | null;
};
export type ZlMessage = { id: string; senderType: "self" | "contact" | string; senderName: string | null; content: string | null; contentType: string; sentAt: string };
export async function zlcrmAccounts(c: ZlCreds): Promise<ZlAccount[]> {
  const r = await zl(c, "/api/public/zalo-accounts");
  if (!Array.isArray(r?.accounts)) throw new ConnectorError("InvalidRequest", "ZL-CRM: phản hồi không đúng định dạng (sai địa chỉ?)");
  return r.accounts;
}
export async function zlcrmConversations(c: ZlCreds, opts: { since?: string; limit?: number } = {}): Promise<ZlConversation[]> {
  const qs = new URLSearchParams({ limit: String(opts.limit ?? 100), threadType: "user", ...(opts.since ? { since: opts.since } : {}) });
  return (await zl(c, `/api/public/conversations?${qs}`)).conversations ?? [];
}
export async function zlcrmMessages(c: ZlCreds, conversationId: string, limit = 30): Promise<ZlMessage[]> {
  return (await zl(c, `/api/public/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`)).messages ?? [];
}
export async function zlcrmSend(c: ZlCreds, spec: { zaloAccountId: string; threadId: string; threadType?: "user" | "group"; content: string }) {
  await zl(c, "/api/public/messages/send", { method: "POST", body: JSON.stringify({ zaloAccountId: spec.zaloAccountId, threadId: spec.threadId, threadType: spec.threadType ?? "user", content: spec.content }) });
}
