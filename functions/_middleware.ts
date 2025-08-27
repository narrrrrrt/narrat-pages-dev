// functions/_middleware.ts
// 1) SSE: /?room=... は DO にプロキシ
// 2) それ以外は next() に通す
// 3) next() のレスポンスを見て HTML/PLAIN を R2 に記録

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

  // --- 1) SSE ---
  if (accept.includes("text/event-stream") && url.searchParams.has("room")) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);

    const doUrl = new URL("/sse" + url.search, "https://do.local");
    return await stub.fetch(doUrl, {
      method: "GET",
      headers: { "Accept": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  // --- 2) その他は通常処理 ---
  const res = await next();

  // --- 3) ログ対象か確認 ---
  try {
    const ct = (res.headers.get("Content-Type") || "").toLowerCase();
    const isEventStream = ct.includes("text/event-stream");
    const isHtml = ct.includes("text/html");
    const isPlain = ct.includes("text/plain");

    if (!isEventStream && (isHtml || isPlain)) {
      const item: LogItem = {
        ts: Date.now(),
        url: url.toString(),
        code: res.status,
        ip: request.headers.get("CF-Connecting-IP"),
        ua: request.headers.get("User-Agent"),
      };

      const bucket = env.LOG_BUCKET as R2Bucket;
      const now = new Date();
      const key = `logs/${now.getUTCFullYear()}-${String(
        now.getUTCMonth() + 1
      ).padStart(2, "0")}/${now.getUTCDate()}/min-${String(
        now.getUTCHours()
      ).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}.jsonl`;

      let prev = "";
      const exist = await bucket.get(key);
      if (exist) prev = await exist.text();

      const body = (prev ? prev + "\n" : "") + JSON.stringify(item);
      await bucket.put(key, body, {
        httpMetadata: { contentType: "application/json" },
      });
    }
  } catch (e) {
    console.warn("log error", e);
  }

  return res;
};