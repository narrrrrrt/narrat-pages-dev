// v0.3  -- unify endpoint "/" for both HTML and SSE
// - Accept: text/event-stream → SSE
// - otherwise:
//    - if ?room=... present → serve /reverse.html (URL stays "/")
//    - else → static (index.html etc.)

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

// demo initial board
const initialBoard = [
  "--------", "--------", "--------", "---WB---",
  "---BW---", "--------", "--------", "--------",
];

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 1) SSE: Accept ヘッダーで判定
  if (isSSE(request)) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const write = (s: string) => writer.write(enc.encode(s));
    const send = (event: string, data: any) => {
      write(`event: ${event}\n`);
      write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const room = url.searchParams.get("room") || "all";
    const seat = url.searchParams.get("seat") || "observer";
    const scope = room === "all" ? "lobby" : "room";

    // 初回スナップショット
    if (scope === "lobby") {
      send("room_state", {
        ts: Date.now(),
        scope,
        room,
        state: {
          boards: [
            { room: 1, seats: { black: "vacant", white: "vacant" }, watchers: 0, status: "waiting", turn: "-" },
            { room: 2, seats: { black: "vacant", white: "vacant" }, watchers: 0, status: "waiting", turn: "-" },
            { room: 3, seats: { black: "vacant", white: "vacant" }, watchers: 0, status: "waiting", turn: "-" },
            { room: 4, seats: { black: "vacant", white: "vacant" }, watchers: 0, status: "waiting", turn: "-" },
          ],
        },
      });
    } else {
      send("room_state", {
        ts: Date.now(),
        scope,
        room: Number(room),
        state: {
          boards: [
            { room: Number(room), seats: { black: "vacant", white: "vacant" }, watchers: 0, status: "waiting", turn: "-" },
          ],
          board: { size: 8, stones: initialBoard },
        },
      });
    }

    // 心拍
    const interval = setInterval(() => write(`: ping ${Date.now()}\n\n`), 3000);

    // 切断
    request.signal.addEventListener("abort", () => {
      clearInterval(interval);
      writer.close();
    });

    return new Response(readable, { headers: sseHeaders() });
  }

  // 2) 非SSEで ?room= が付いている → /reverse.html を返す（URLは / のまま）
  if (url.searchParams.has("room")) {
    const u = new URL(request.url);
    u.pathname = "/reverse.html";
    return env.ASSETS.fetch(new Request(u.toString(), request));
  }

  // 3) それ以外は通常の静的配信（/index.html 等）
  return next();
};