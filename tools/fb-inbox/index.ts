// 序曲音樂學院｜廣告作戰台 — fb-inbox（唯讀）
//
// 讀粉專 Messenger 收件匣：某個時間之後有更新的對話，以及每則對話最近的訊息。
// 給每天的廣告 agent 用：判斷對話來源、走到哪一步、沒約成的原因。
//
// 只接受 service_role 呼叫；只讀，不傳訊息、不標已讀、不改任何東西。
// 權杖：Edge Function Secret `META_PAGE_TOKEN`（系統用戶 xuquadssync，
//       權限 ads_read / pages_show_list / pages_read_engagement / pages_messaging，粉專只開「訊息」）。
//
// 呼叫 body（都選填）：{ "since": "2026-11-03", "limit": 50, "messages_per_thread": 20 }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GRAPH_VER = Deno.env.get("META_API_VERSION") ?? "v23.0";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const G = `https://graph.facebook.com/${GRAPH_VER}`;

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

async function get(url: string) {
  const res = await fetch(url);
  const b = await res.json().catch(() => null);
  if (!res.ok || b?.error) throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
  return b;
}

Deno.serve(async (req) => {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer !== SRK && jwtRole(bearer) !== "service_role") return json({ ok: false, error: "forbidden" }, 401);

  const userTok = Deno.env.get("META_PAGE_TOKEN");
  if (!userTok) return json({ ok: false, error: "missing META_PAGE_TOKEN" }, 400);

  const body = await req.json().catch(() => ({}));
  const since = typeof body?.since === "string" ? body.since : new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  const limit = Math.min(Math.max(Number(body?.limit ?? 50), 1), 200);
  const perThread = Math.min(Math.max(Number(body?.messages_per_thread ?? 20), 1), 50);
  const sinceTs = Date.parse(`${since}T00:00:00+08:00`);

  try {
    // 1. 系統用戶權杖 → 粉專權杖
    const pages = await get(`${G}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userTok)}`);
    const page = (pages.data ?? [])[0];
    if (!page) return json({ ok: false, error: "no_page_assigned" }, 400);

    // 2. 對話（依更新時間新到舊），翻頁直到早於 since
    const fields = `id,updated_time,message_count,participants,messages.limit(${perThread}){message,from,created_time}`;
    let next: string | null =
      `${G}/${page.id}/conversations?platform=messenger&fields=${encodeURIComponent(fields)}&limit=25&access_token=${encodeURIComponent(page.access_token)}`;
    const threads: unknown[] = [];
    while (next && threads.length < limit) {
      const b = await get(next);
      let stop = false;
      for (const c of b.data ?? []) {
        if (Date.parse(c.updated_time) < sinceTs) { stop = true; break; }
        const customer = (c.participants?.data ?? []).find((p: { id: string }) => p.id !== page.id);
        threads.push({
          id: c.id,
          customer: customer?.name ?? null,
          updated: c.updated_time,
          message_count: c.message_count,
          messages: (c.messages?.data ?? []).reverse().map((m: { from?: { id: string }; message?: string; created_time: string }) => ({
            at: m.created_time,
            by: m.from?.id === page.id ? "序曲" : "客人",
            text: m.message ?? "",
          })),
        });
        if (threads.length >= limit) break;
      }
      next = stop ? null : b.paging?.next ?? null;
    }
    return json({ ok: true, page: page.name, since, count: threads.length, threads });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 502);
  }
});
