// functions/sse.ts
// /sse?room=all | /sse?room=1&seat=black&sse=... を DO の /sse にそのまま中継するだけ。
// 静的資産には一切触れないため、リダイレクトループの原因になりません。

export const onRequestGet: PagesFunction = async (ctx) => {
  const { request, env } = ctx;
  const id = env.REVERSI_HUB.idFromName('global');
  const stub = env.REVERSI_HUB.get(id);

  const url = new URL(request.url);
  const doUrl = new URL('/sse' + url.search, 'https://do.local');

  const init: RequestInit = {
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      // 任意：ログ用
      'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || ''
    },
  };
  return await stub.fetch(doUrl, init);
};