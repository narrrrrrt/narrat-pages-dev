// functions/api/admin.ts
export const onRequestPost: PagesFunction = async (ctx) => {
  const { env } = ctx;
  const id = env.REVERSI_HUB.idFromName('global');
  const stub = env.REVERSI_HUB.get(id);
  const url = new URL('/admin', 'https://do.local');
  return await stub.fetch(new Request(url, { method:'POST' }));
};