export const onRequestPost: PagesFunction<{ REVERSI_HUB: DurableObjectNamespace }> = async ({ request, env }) => {
  const id = env.REVERSI_HUB.idFromName('hub');
  const stub = env.REVERSI_HUB.get(id);
  const host = request.headers.get('Host') || '';
  const r = await stub.fetch(new Request('https://do/lobby/state', {
    method: 'POST',
    headers: { 'X-Host': host }
  }));
  return r;
};