// functions/_middleware.ts
// 目的: 最小限の SSE プロキシのみ。その他は素通し。
// - GET "/" で Accept: text/event-stream の場合のみ DO へフォワード
// - リライト/リダイレクト/ログは一切しない

export const onRequest: PagesFunction = async (ctx) => {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const accept = request.headers.get("accept") || "";

  // ロビー/ルームの SSE は DO へ
  if (
    request.method === "GET" &&
    url.pathname === "/" &&
    accept.includes("text/event-stream")
  ) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  }

  // それ以外は素通し（/reverse.html や /api/* を含む）
  return next();
};