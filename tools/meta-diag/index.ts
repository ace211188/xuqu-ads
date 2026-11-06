// 序曲音樂學院｜廣告作戰台 — meta-diag（臨時診斷用，唯讀）
//
// 用途：比較好幾波廣告的觀看、版位、年齡、累積觸及，找出廣告「掉在哪一段」。
// 用法與背景見 ../../廣告診斷手冊.md 第五節。
//
// 平常 Supabase 上部署的是停用版（回 410）；要診斷時才部署這份，用完改回停用版。
// 只接受 service_role 呼叫；只讀 Meta Insights，不寫任何資料。
//
// 需要的 Edge Function Secrets（跟 meta-sync 共用）：META_TOKEN、META_AD_ACCOUNT_ID、META_API_VERSION（選填）
//
// 呼叫 body：
// {
//   "windows": [ { "key": "w4_nov", "camp": "<Meta 行銷活動 ID>", "since": "YYYY-MM-DD", "until": "YYYY-MM-DD" }, ... ],
//   "cumulative": { "<名稱>": { "camps": ["<ID>", ...], "since": "...", "until": "..." }, ... }   // 選填
// }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GRAPH_VER = Deno.env.get("META_API_VERSION") ?? "v23.0";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jwtRole(tok: string): string | null {
  try {
    const p = tok.split(".")[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(p.length / 4) * 4, "=");
    return (JSON.parse(atob(b64))?.role as string | undefined) ?? null;
  } catch {
    return null;
  }
}

type Win = { key: string; camp: string; since: string; until: string };
type Cum = { camps: string[]; since: string; until: string };

const BASE_FIELDS = [
  "spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks", "actions",
  "video_p25_watched_actions", "video_p50_watched_actions", "video_p75_watched_actions",
  "video_p95_watched_actions", "video_p100_watched_actions", "video_avg_time_watched_actions",
  "video_thruplay_watched_actions", "video_30_sec_watched_actions",
].join(",");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer !== SRK && jwtRole(bearer) !== "service_role") return json({ ok: false, error: "forbidden" }, 401);

  const token = Deno.env.get("META_TOKEN");
  const raw = Deno.env.get("META_AD_ACCOUNT_ID");
  if (!token || !raw) return json({ ok: false, error: "missing_secrets" }, 400);
  const acct = raw.startsWith("act_") ? raw : `act_${raw}`;

  const body = await req.json().catch(() => ({}));
  const windows: Win[] = Array.isArray(body?.windows) ? body.windows : [];
  const cumulative: Record<string, Cum> = body?.cumulative ?? {};
  if (!windows.length && !Object.keys(cumulative).length) {
    return json({ ok: false, error: "need windows or cumulative in body" }, 400);
  }

  const q = async (params: Record<string, string>) => {
    const p = new URLSearchParams({ ...params, limit: "500", access_token: token });
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${acct}/insights?${p}`);
    const b = await res.json().catch(() => null);
    if (!res.ok || b?.error) return { error: b?.error?.message ?? res.status };
    return b.data ?? [];
  };
  const filt = (ids: string[]) => JSON.stringify([{ field: "campaign.id", operator: "IN", value: ids }]);
  const tr = (s: string, u: string) => JSON.stringify({ since: s, until: u });

  const out: Record<string, unknown> = { ok: true };
  for (const w of windows) {
    const base = { level: "campaign", time_range: tr(w.since, w.until), filtering: filt([w.camp]) };
    out[w.key] = {
      total: await q({ ...base, fields: BASE_FIELDS }),
      by_placement: await q({ ...base, fields: "spend,impressions,inline_link_clicks,actions", breakdowns: "publisher_platform,platform_position" }),
      by_age: await q({ ...base, fields: "impressions,inline_link_clicks,actions", breakdowns: "age" }),
    };
  }
  const cum: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(cumulative)) {
    cum[name] = await q({ level: "account", time_range: tr(c.since, c.until), fields: "reach,impressions,frequency", filtering: filt(c.camps) });
  }
  out.cumulative = cum;
  return json(out);
});
