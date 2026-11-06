// 序曲音樂學院｜廣告作戰台 — ads-metrics（唯讀，常駐）
//
// 給每天的廣告 agent 用：抓「點擊→對話」和「新觸及比例」需要的數字。
// 比 meta-diag 輕：不抓影片、版位、年齡細分。
// 只接受 service_role 呼叫；只讀 Meta Insights。權杖：META_TOKEN（ads_read）。
//
// body：
// {
//   "windows": [ { "key": "nov", "camps": ["<Meta 行銷活動 ID>"], "since": "YYYY-MM-DD", "until": "YYYY-MM-DD", "daily": true } ],
//   "reach":   [ { "key": "before", "camps": ["..."], "since": "...", "until": "..." } ]
// }
// 回傳每個 window 的 spend / impressions / reach / frequency / link_clicks / msgs（daily=true 時另附逐日），
// 以及每個 reach 區間的不重複觸及。新觸及比例 = (all − before) ÷ now，由 agent 自己算。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GRAPH_VER = Deno.env.get("META_API_VERSION") ?? "v23.0";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MSG = "onsite_conversion.messaging_conversation_started_7d";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

type Row = Record<string, unknown> & { actions?: { action_type: string; value: string }[] };
const pick = (r: Row) => ({
  date: r.date_start ?? null,
  spend: Math.round(num(r.spend)),
  impressions: num(r.impressions),
  reach: num(r.reach),
  frequency: Number(num(r.frequency).toFixed(2)),
  link_clicks: num(r.inline_link_clicks),
  msgs: num((r.actions ?? []).find((a) => a.action_type === MSG)?.value),
});

Deno.serve(async (req) => {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer !== SRK && jwtRole(bearer) !== "service_role") return json({ ok: false, error: "forbidden" }, 401);

  const token = Deno.env.get("META_TOKEN");
  const raw = Deno.env.get("META_AD_ACCOUNT_ID");
  if (!token || !raw) return json({ ok: false, error: "missing_secrets" }, 400);
  const acct = raw.startsWith("act_") ? raw : `act_${raw}`;

  const body = await req.json().catch(() => ({}));
  const windows = Array.isArray(body?.windows) ? body.windows : [];
  const reach = Array.isArray(body?.reach) ? body.reach : [];

  const q = async (params: Record<string, string>) => {
    const p = new URLSearchParams({ ...params, limit: "500", access_token: token });
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${acct}/insights?${p}`);
    const b = await res.json().catch(() => null);
    if (!res.ok || b?.error) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
    return (b.data ?? []) as Row[];
  };
  const filt = (ids: string[]) => JSON.stringify([{ field: "campaign.id", operator: "IN", value: ids }]);
  const tr = (s: string, u: string) => JSON.stringify({ since: s, until: u });
  const F = "spend,impressions,reach,frequency,inline_link_clicks,actions";

  try {
    const out: Record<string, unknown> = { ok: true, windows: {}, reach: {} };
    for (const w of windows) {
      const base = { level: "account", time_range: tr(w.since, w.until), filtering: filt(w.camps), fields: F };
      const total = (await q(base))[0];
      const entry: Record<string, unknown> = { total: total ? pick(total) : pick({}) };
      if (w.daily) entry.daily = (await q({ ...base, time_increment: "1" })).map(pick);
      (out.windows as Record<string, unknown>)[w.key] = entry;
    }
    for (const r of reach) {
      const row = (await q({ level: "account", time_range: tr(r.since, r.until), filtering: filt(r.camps), fields: "reach,impressions,frequency" }))[0];
      (out.reach as Record<string, unknown>)[r.key] = row ? { reach: num(row.reach), impressions: num(row.impressions), frequency: num(row.frequency) } : null;
    }
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 502);
  }
});
