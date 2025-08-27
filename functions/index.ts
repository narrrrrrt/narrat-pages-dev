// functions/index.ts  (v0.3)
import {
  getLobbySnapshot,
  getRoomSnapshot,
  subscribeLobby,
  subscribeRoom,
} from "./api/_state";

function isSSE(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/event-stream");
}
function sseHeaders(): Headers {
  return new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "pragma": "no-cache",
  });
}

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 1) SSE
  if (isSSE(request)) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const write = (s: string) => writer.write(enc.encode(s));

    const roomParam = url.searchParams.get("room") || "all";
    if (roomParam === "all") {
      // 初回
      write(`event: room_state\ndata: ${JSON.stringify(getLobbySnapshot())}\n\n`);
      // 購読
      subscribeLobby(write, request.signal);
    } else {
      const room = Number(roomParam);
      write(`event: room_state\ndata: ${JSON.stringify(getRoomSnapshot(room))}\n\n`);
      subscribeRoom(room, write, request.signal);
    }

    const interval = setInterval(() => write(`: ping ${Date.now()}\n\n`), 3000);
    request.signal.addEventListener("abort", () => {
      clearInterval(interval);
      writer.close();
    });

    return new Response(readable, { headers: sseHeaders() });
  }

  // 2) 非SSEで ?room= が付いている → reverse.html を返す（URLは / のまま）
  if (url.searchParams.has("room")) {
    const u = new URL(request.url);
    u.pathname = "/reverse.html";
    return env.ASSETS.fetch(new Request(u.toString(), request));
  }

  // 3) 静的配信
  return next();
};