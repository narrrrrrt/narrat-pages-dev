// functions/_middleware.ts -- v1.1.2
// 1) SSE: GET かつ Accept: text/event-stream かつ ?room=… → DO /sse へプロキシ
// 2) 通常は next()
// 3) text/html・text/plain のレスだけ R2 に JSONL で保存（失敗は握りつぶし）

type Env = {
  LOG_BUCKET?: R2Bucket;
  REVERSI_HUB: DurableObjectNamespace;
};

type LogItem = {
  ts: number;
  url: string;
  code: number;
  ip?: string | null;
  ua?: string | null;
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const accept = (request.headers.get('Accept') || '').toLowerCase();

  // --- 1) SSE を DO へ ---
  if (
    request.method === 'GET' &&
    accept.includes('text/event-stream') &&
    url.searchParams.has('room')
  ) {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);

    const doUrl = new URL('/sse' + url.search, 'https://do.local');
    const doReq = new Request(doUrl, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    });

    const doRes = await stub.fetch(doReq);
    // SSE はストリームをそのまま返す
    return new Response(doRes.body, { status: doRes.status, headers: doRes.headers });
  }

  // --- 2) 通常処理 ---
  const res = await next();

  // --- 3) R2 へメタだけ保存（HTML/PLAIN のみ）---
  try {
    const bucket = env.LOG_BUCKET;
    if (!bucket) return res;

    const ct = (res.headers.get('Content-Type') || '').toLowerCase();
    const isEventStream = ct.includes('text/event-stream');
    const isHtml = ct.includes('text/html');
    const isPlain = ct.includes('text/plain');
    if (isEventStream || (!isHtml && !isPlain)) return res;

    const item: LogItem = {
      ts: Date.now(),
      url: url.pathname + url.search,
      code: res.status,
      ip: request.headers.get('cf-connecting-ip'),
      ua: request.headers.get('user-agent'),
    };

    const d = new Date(item.ts);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
    const rid = Math.random().toString(36).slice(2, 8);

    const key = `logs/${yyyy}-${mm}/${dd}/${hh}${mi}/${ss}-${ms}-${rid}.jsonl`;
    const line = JSON.stringify(item) + '\n';

    await bucket.put(key, line, {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (e) {
    // 失敗は握りつぶし（本レスポンスを優先）
    console.warn('log error', e instanceof Error ? e.message : String(e));
  }

  return res;
};