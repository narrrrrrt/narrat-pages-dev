// functions/api/admin.ts -- v0.4（デバッグ用全初期化）
export const onRequestPost: PagesFunction = async (context) => {
  const { env } = context;
  const id = env.REVERSI_HUB.idFromName("global");
  const stub = env.REVERSI_HUB.get(id);
  return stub.fetch("https://do/admin", { method: "POST" });
};

export const onRequestGet: PagesFunction = async () => {
  return new Response("POST /api/admin で全初期化（デバッグ用）", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};