// functions/_middleware.ts
// ルーティングはこの1ファイルに集約します。
// - SSE: Accept: text/event-stream && ?room=... → DO /sse にプロキシ
// - 画面: ?room= があれば /reverse.html、無ければ /index.html を ASSETS から内部取得（リダイレクトしない）

export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const accept = request.headers.get('Accept') || '';

  // 1) SSE（ロビー or ルーム）
  if (accept.includes('text/event-stream') && url.searchParams.has('room')) {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);

    // DO 側の /sse にクエリ付きでそのまま投げる（内部通信）
    const doUrl = new URL('/sse' + url.search, 'https://do.local');
    const init: RequestInit = {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        // ログ用途（任意）
        'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || ''
      }
    };
    return await stub.fetch(doUrl, init);
  }

  // 2) 画面の内部振り分け（リダイレクトしない：ASSETS.fetch に直接渡す）
  const assetPath = url.searchParams.has('room') ? '/reverse.html' : '/index.html';
  const assetReq = new Request(new URL(assetPath, url.origin), request);
  return await env.ASSETS.fetch(assetReq);
}