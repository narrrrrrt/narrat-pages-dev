// functions/_middleware.ts
// 1) SSE: /?room=... & Accept: text/event-stream → DO /sse にプロキシ
// 2) その他は next() へ
// 3) HTML/PLAIN のレスだけ、R2 に 1 行（1 オブジェクト）で保存（競合なし）

type LogItem = {
  ts: number;
  url: string;
  code: number;
  ip?: string | null;
  ua?: string | null;
};

export const onRequest: PagesFunction = async (ctx) => {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const accept = request.headers.get("Accept") || "";

  // --- 1) SSE を DO に中継 ---
  if (accept.includes("text/event-stream") && url.searchParams.has("room")) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    const doUrl = new URL("/sse" + url.search, "https://do.local");
    return await stub.fetch(doUrl, {
      method: "GET",
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  // --- 2) 通常処理 ---
  const res = await next();

  // --- 3) R2 へメタだけ保存（HTML/PLAIN のみ）---
  try {
    const bucket = (env as any).LOG_BUCKET as R2Bucket | undefined;
    if (!bucket) return res;

    const ct = (res.headers.get("Content-Type") || "").toLowerCase();
    const isEventStream = ct.includes("text/event-stream");
    const isHtml = ct.includes("text/html");
    const isPlain = ct.includes("text/plain");
    if (isEventStream || !(isHtml || isPlain)) return res;

    const item: LogItem = {
      ts: Date.now(),
      url: url.toString(),
      code: res.status,
      ip: request.headers.get("CF-Connecting-IP"),
      ua: request.headers.get("User-Agent"),
    };

    // 1イベント=1オブジェクト（衝突なし）。日付フォルダ配下に保存
    const now = new Date(item.ts);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const h = String(now.getUTCHours()).padStart(2, "0");
    const m = String(now.getUTCMinutes()).padStart(2, "0");
    const s = String(now.getUTCSeconds()).padStart(2, "0");
    const ms = String(now.getUTCMilliseconds()).padStart(3, "0");
    const rid = Math.random().toString(36).slice(2, 8);

    const key = `logs/${yyyy}-${mm}/${dd}/${h}${m}/${s}-${ms}-${rid}.jsonl`;
    const line = JSON.stringify(item) + "\n";

    await bucket.put(key, line, {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    // 失敗は握りつぶし（本レスポンスを優先）
    console.warn("log error", e instanceof Error ? e.message : String(e));
  }

  return res;
};