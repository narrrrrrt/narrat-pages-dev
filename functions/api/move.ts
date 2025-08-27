// functions/api/move.ts
import type { Env } from '../types';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const id = env.REVERSI_HUB.idFromName('global');
  const stub = env.REVERSI_HUB.get(id);

  const body = await request.text();
  const url = new URL('/move', 'https://do.local');
  const doReq = new Request(url, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Play-Token': request.headers.get('X-Play-Token') || '',
    }
  });

  const res = await stub.fetch(doReq);
  // （初手ログなどのためのヘッダはそのまま通す）
  return new Response(res.body, { status: res.status, headers: res.headers });
};