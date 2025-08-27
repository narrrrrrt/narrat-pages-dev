// functions/api/action.ts -- v0.4
export const onRequestPost: PagesFunction = async (context) => {
  const { request, env } = context;

  const id = env.REVERSI_HUB.idFromName("global");
  const stub = env.REVERSI_HUB.get(id);

  // X-Play-Token をそのまま中継
  const headers = new Headers(request.headers);
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Play-Token": headers.get("X-Play-Token") || "",
    },
    body: await request.text(),
  };
  return stub.fetch("https://do/action", init);
};