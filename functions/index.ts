// functions/index.ts

function isSSE(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/event-stream");
}

function sseHeaders(): Headers {
  return new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "pragma": "no-cache"
  });
}

const initialBoard = [
  "--------","--------","--------","---WB---",
  "---BW---","--------","--------","--------"
];

export const onRequestGet: PagesFunction = async ({ request, next }) => {
  const url = new URL(request.url);
  if (!isSSE(request)) return next(); // Acceptが無い時は静的配信

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
          { room: 4, seats: { black: "vacant", white: "vacant" }, watchers: 0, status: "waiting", turn: "-" }
        ]
      }
    });
  } else {
    send("room_state", {
      ts: Date.now(),
      scope,
      room: Number(room),
      state: {
        boards: [{ room: Number(room), seats: { black: "vacant", white: "vacant" }, watchers: 0, status: "waiting", turn: "-" }],
        board: { size: 8, stones: initialBoard }
      }
    });
  }

  // ハートビート
  const interval = setInterval(() => write(`: ping ${Date.now()}\n\n`), 3000);

  // 切断
  request.signal.addEventListener("abort", () => {
    clearInterval(interval);
    writer.close();
  });

  return new Response(readable, { headers: sseHeaders() });
};