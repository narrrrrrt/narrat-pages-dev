// functions/index.ts
// Serves SSE on GET /?room=... when Accept includes text/event-stream.
// Otherwise falls through to static assets from /public.

function isSSE(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/event-stream");
}

function sseHeaders(): Headers {
  return new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
}

// A tiny in-memory demo snapshot per room
const initialBoard = [
  "--------","--------","--------","---WB---",
  "---BW---","--------","--------","--------"
];

export const onRequestGet: PagesFunction = async (context) => {
  const { request } = context;
  const url = new URL(request.url);
  if (!isSSE(request)) {
    // Not SSE → let static handle it
    return context.next();
  }

  const room = url.searchParams.get("room") || "all";
  const seat = url.searchParams.get("seat") || "observer";

  const stream = new ReadableStream({
    start(controller) {
      const send = (name: string, data: any) => {
        controller.enqueue(`event: ${name}\n`);
        controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
      };

      const scope = room === "all" ? "lobby" : "room";
      // send an initial snapshot
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
            board: { size: 8, stones: initialBoard },
          }
        });
      }

      // heartbeat (3s)
      const timer = setInterval(() => {
        controller.enqueue(": ping\n\n");
      }, 3000);

      // close when the connection is gone
      const cancel = () => clearInterval(timer);
      // @ts-ignore
      controller.signal?.addEventListener?.("abort", cancel);
    }
  });

  return new Response(stream, { headers: sseHeaders() });
};
