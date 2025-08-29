// functions/_middleware.ts
export const onRequest: PagesFunction<{ REVERSI_HUB: DurableObjectNamespace }> = async (ctx) => {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const accept = request.headers.get('accept') || '';

  const forwardToDO = async () => {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);
    const req = new Request(url.toString(), request);
    const res = await stub.fetch(req);
    // SSEはキャッシュさせない
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      const h = new Headers(res.headers);
      h.set('cache-control', 'no-store');
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  };

  // 1) API は常に DO
  if (url.pathname.startsWith('/api/')) return forwardToDO();

  // 2) SSE（ロビー/ルーム）は Accept で判定して DO
  if (accept.includes('text/event-stream')) return forwardToDO();

  // 3) それ以外は静的
  return next();
};