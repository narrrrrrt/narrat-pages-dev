// functions/index.ts
import type { Env } from './types';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const accept = request.headers.get('Accept') || '';

  // SSE: /?room=... (&seat=... [&sse=...])
  if (accept.includes('text/event-stream') && url.searchParams.has('room')) {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);
    // DOに /sse をそのままプロキシ（クエリは維持）
    const doUrl = new URL('/sse' + url.search, 'https://do.local');
    const init: RequestInit = {
      method: 'GET',
      headers: {
        // パススルー（User-Agent等は省略可）
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || ''
      },
    };
    return await stub.fetch(doUrl, init);
  }

  // 画面：/index.html（ロビー） or /reverse.html（ルーム）
  const hasRoom = url.searchParams.has('room');
  const file = hasRoom ? '/reverse.html' : '/index.html';
  return await env.ASSETS.fetch(new Request(new URL(file, url.origin), request));
};