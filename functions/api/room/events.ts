export const onRequestGet: PagesFunction<{ REVERSI_HUB: DurableObjectNamespace }> = async ({ request, env }) => {
  const id = env.REVERSI_HUB.idFromName('hub');
  const stub = env.REVERSI_HUB.get(id);
  const u = new URL(request.url);
  const host = request.headers.get('Host') || '';
  const r = await stub.fetch(new Request('https://do/room/events?' + u.searchParams.toString(), {
    headers: { 'X-Host': host }
  }));
  return r; // SSEそのまま
};