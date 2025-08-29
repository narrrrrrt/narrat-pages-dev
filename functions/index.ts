// functions/index.ts
// 役割: 「/」の静的配信と SSE を Accept で分岐。
// - Accept: text/event-stream → DOへプロキシ
// - それ以外: room クエリの有無で index.html / reverse.html を返す

export const onRequestGet: PagesFunction = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const accept = request.headers.get("accept") || "";

  // --- SSE（ロビー/ルーム共通）---
  if (accept.includes("text/event-stream")) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    // DO 側 (workers/do-worker/worker.ts) が "/" で SSE を処理する
    return stub.fetch(request);
  }

  // --- 画面振り分け ---
  const roomQ = Number(url.searchParams.get("room") || "0");
  const target = (roomQ >= 1 && roomQ <= 4) ? "/reverse.html" : "/index.html";

  // 静的アセットを返す
  const assetUrl = new URL(target, url);
  const assetReq = new Request(assetUrl.toString(), request);
  return env.ASSETS.fetch(assetReq);
};