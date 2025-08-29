// functions/_middleware.ts
// Pages Functions middleware: static files are served by Pages,
// SSE/API は Durable Object(REVERSI_HUB) にプロキシする。

interface Env {
  REVERSI_HUB: DurableObjectNamespace;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const accept = request.headers.get('Accept') || '';
  const isSSE = accept.includes('text/event-stream');

  // DO へそのまま転送
  const passToDO = async (req: Request) => {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(req);
  };

  // DO へパスを書き換えて転送（/ → /sse 等）
  const passToDOWithPath = async (req: Request, newPath: string) => {
    const u2 = new URL(req.url);
    u2.pathname = newPath;
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(new Request(u2.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'manual',
    }));
  };

  // --- SSE: ロビー集約（/?room=all）とルーム個別（/sse）の両方を許可 ---
  if (isSSE) {
    // ルーム個別（reverse.html からの /sse?room=..&seat=..）
    if (url.pathname === '/sse') {
      return passToDO(request);
    }
    // ロビー集約（index.html からの /?room=all）
    if (url.pathname === '/' && url.searchParams.has('room')) {
      return passToDOWithPath(request, '/sse');
    }
  }

  // --- API: /api/* はすべて DO にフォワード（join/move/leave/hb/admin など） ---
  if (url.pathname.startsWith('/api/')) {
    return passToDO(request);
  }

  // --- それ以外は Pages の静的配信へ ---
  return next();
};