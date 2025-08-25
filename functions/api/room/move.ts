export const onRequestPost: PagesFunction<{ REVERSI_HUB: DurableObjectNamespace }> = async ({ request, env }) => {
  const id = env.REVERSI_HUB.idFromName('hub');
  const stub = env.REVERSI_HUB.get(id);
  const u = new URL(request.url);
  const room = u.searchParams.get('room');
  const body = await request.text();
  const host = request.headers.get('Host') || '';
  const r = await stub.fetch(new Request(`https://do/room/${room}/move`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-Host': host },
    body
  }));
  return r;
};