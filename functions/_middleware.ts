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

  // --- SSE を DO に繋ぎ替え（既存） ---
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) {
    const u = new URL(request.url);
    const seat = u.searchParams.get('seat') || 'observer';
    const room = u.searchParams.get('room') || 'all';
    if (room === 'all') {
      // ロビー
      const id = env.REVERSI_HUB.idFromName("global");
      const stub = env.REVERSI_HUB.get(id);
      const target = new URL("/lobby-sse", new URL(request.url));
      return stub.fetch(target, { headers: { accept: 'text/event-stream' } as any });
    } else {
      // ルーム
      const id = env.REVERSI_HUB.idFromName("global");
      const stub = env.REVERSI_HUB.get(id);
      const target = new URL(`/room-sse?room=${room}&seat=${seat}`, new URL(request.url));
      return stub.fetch(target, { headers: { accept: 'text/event-stream' } as any });
    }
  }

  // それ以外は素通し
  const res = await next();

  // --- （任意）HTML/PLAIN のみ R2 へメタだけ保存（HTML/PLAIN のみ）---
  try {
    const bucket = (env as any).LOG_BUCKET as R2Bucket | undefined;
    if (!bucket) return res;

    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|text\/plain/.test(ct)) return res;

    const item: LogItem = {
      ts: Date.now(),
      url: url.toString(),
      code: res.status,
      ip: request.headers.get("cf-connecting-ip"),
      ua: request.headers.get("user-agent"),
    };

    const d = new Date(item.ts);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const h  = String(d.getUTCHours()).padStart(2, "0");
    const m  = String(d.getUTCMinutes()).padStart(2, "0");
    const s  = String(d.getUTCSeconds()).padStart(2, "0");
    const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
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