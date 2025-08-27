// functions/api/action.ts
import type { Env } from '../types';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const id = env.REVERSI_HUB.idFromName('global');
  const stub = env.REVERSI_HUB.get(id);

  const body = await request.text();
  const url = new URL('/action', 'https://do.local');
  const doReq = new Request(url, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Play-Token': request.headers.get('X-Play-Token') || '',
    }
  });

  const res = await stub.fetch(doReq);
  // JOIN時のトークンを中継
  const hdrs = new Headers(res.headers);
  const token = res.headers.get('X-Play-Token');
  if (token) hdrs.set('X-Play-Token', token);

  return new Response(res.body, { status: res.status, headers: hdrs });
};