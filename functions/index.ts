// functions/index.ts -- v0.4a
// 目的:
//  - Accept: text/event-stream のとき **Durable Object(ReversiHub)の /sse** にプロキシ
//  - 非SSEで ?room=... が付いているときは /reverse.html を返す（URLは "/" のまま）
//  - それ以外は静的配信（/index.html 等）
//
// 備考:
//  - v0.4 で残っていたプレースホルダーJSON応答を完全排除
//  - クエリ (?room=..., ?seat=...) は DO へそのまま継承

function isSSE(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/event-stream");
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 1) SSE: DO "/sse" へプロキシ
  if (isSSE(request)) {
    // Durable Object: 固定ID "global" を使用（単一ハブ）
    const id = (env as any).REVERSI_HUB.idFromName("global");
    const stub = (env as any).REVERSI_HUB.get(id);

    const target = new URL("https://do/sse");
    target.search = url.search; // room=all / room=1&seat=... 等を引き継ぎ

    // EventSource 互換のヘッダでGET
    const init: RequestInit = {
      method: "GET",
      headers: { accept: "text/event-stream" },
    };

    // そのまま DO のレスポンスを返す（content-type: text/event-stream）
    return await stub.fetch(target.toString(), init);
  }

  // 2) 非SSE: ?room= が付いていれば /reverse.html を返す（URLは "/" のまま）
  if (url.searchParams.has("room")) {
    const u = new URL(request.url);
    u.pathname = "/reverse.html";
    return (env as any).ASSETS.fetch(new Request(u.toString(), request));
  }

  // 3) 静的（ロビー等）
  return next();
};