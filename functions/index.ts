// functions/index.ts -- v0.4
// - Accept: text/event-stream → DO "/sse" にプロキシ
// - 非SSE & ?room=... → /reverse.html を返す（URLは "/" のまま）
// - それ以外は静的配信

function isSSE(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/event-stream");
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 1) SSE → DOへ
  if (isSSE(request)) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    const u = new URL("https://do/sse");
    u.search = url.search; // room=all / room=1&seat=...
    // 元ヘッダをある程度引き継ぐ
    const init: RequestInit = {
      method: "GET",
      headers: { "accept": "text/event-stream" },
    };
    return stub.fetch(u.toString(), init);
  }

  // 2) 非SSEで ?room= が付いていれば reverse.html を返す
  if (url.searchParams.has("room")) {
    const u = new URL(request.url);
    u.pathname = "/reverse.html";
    return env.ASSETS.fetch(new Request(u.toString(), request));
  }

  // 3) 静的
  return next();
};