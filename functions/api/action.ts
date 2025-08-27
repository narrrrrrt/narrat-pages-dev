// functions/api/action.ts
import { snapshot, tokens, makeToken, startingBoard } from "./_state";

export const onRequestPost: PagesFunction = async (context) => {
  const { request } = context;
  const body = await request.json().catch(()=> ({}));
  const action = body?.action;
  const room = Number(body?.room);
  const seat = String(body?.seat || "observer") as "black"|"white"|"observer";

  let headers = new Headers({ "content-type": "application/json; charset=utf-8" });

  if (action === "join") {
    // Issue a short token and remember it (demo only)
    const token = makeToken(8);
    tokens.set(token, { room, seat });
    headers.set("X-Play-Token", token);
    // Mark this as a cookie for demo (spec doesn't fix transport; cookie is convenient)
        const snap = snapshot(room, seat, seat === "observer" ? "waiting" : "black", seat === "observer" ? null : "black", startingBoard(), [], 0);
    return new Response(JSON.stringify(snap), { headers, status: 200 });
  }

  if (action === "leave") {
    // read token from cookie (demo)
    const cookie = request.headers.get("cookie") || "";
    const m = /(?:^|;\s*)rtok=([^;]+)/.exec(cookie);
    if (m) {
      const token = decodeURIComponent(m[1]);
      tokens.delete(token);
      headers.set("X-Log-Event", "token-deleted");
      headers.set("X-Token", token);
    }
    const snap = snapshot(room, seat, "waiting", null, startingBoard(), [], 0);
    return new Response(JSON.stringify(snap), { headers, status: 200 });
  }

  return new Response(JSON.stringify({ ok:false, reason:"unsupported_action" }), { headers, status: 400 });
};
