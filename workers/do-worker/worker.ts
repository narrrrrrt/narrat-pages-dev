// workers/do-worker/worker.ts
// v1.1.x -- SSEとjoin周りを安定化（ヘッダー認証を廃止・即時スナップショット送出・ハートビートSログ）

export interface Env {
  ReversiDO: DurableObjectNamespace;
}

type Seat = "black" | "white" | "observer";
type Status = "waiting" | "black" | "white" | "ended";

type Board = { size: number; stones: string[] };
type RoomSnapshot = {
  room: number;
  seat: Seat;
  status: Status;
  turn: "black" | "white" | null;
  board: Board;
  legal: string[];
  watchers: number;
};

type LobbySnapshot = {
  rooms: {
    [id: string]: {
      seats: { black: boolean; white: boolean };
      watchers: number;
      status: Status;
    };
  };
  ts: number;
};

const TEXT = new TextEncoder();
const JSONH = { "content-type": "application/json" };

/* ----------------------------------------------------- */
/* Pages entrypoint                                      */
/* ----------------------------------------------------- */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isSSE = req.headers.get("accept")?.includes("text/event-stream");

    // /api/action は必ず DO に投げる
    if (url.pathname === "/api/action") {
      const id = env.ReversiDO.idFromName("reversi");
      const stub = env.ReversiDO.get(id);
      return await stub.fetch(req);
    }

    // SSEは /?room=all | /?room=N のどちらでもここでDOへ
    if (isSSE && url.searchParams.has("room")) {
      const id = env.ReversiDO.idFromName("reversi");
      const stub = env.ReversiDO.get(id);
      return await stub.fetch(req);
    }

    // それ以外（静的）はPagesに任せる（このワーカーは触らない）
    return new Response(null, { status: 404 });
  },
};

/* ----------------------------------------------------- */
/* Durable Object                                         */
/* ----------------------------------------------------- */
export class ReversiDO {
  state: DurableObjectState;

  // 盤面・座席
  rooms: Map<
    number,
    {
      black: boolean;
      white: boolean;
      turn: "black" | "white" | null;
      board: Board;
      status: Status;
      watchers: number; // 接続中SSE(部屋)数
    }
  > = new Map();

  // SSE: ロビー
  sseAll: Set<WritableStreamDefaultWriter> = new Set();
  // SSE: 各部屋
  sseRoom: Map<number, Set<WritableStreamDefaultWriter>> = new Map();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // 初期化（4部屋固定）
    for (let r = 1; r <= 4; r++) {
      this.rooms.set(r, {
        black: false,
        white: false,
        turn: null,
        board: initBoard(),
        status: "waiting",
        watchers: 0,
      });
    }
  }

  /* ---------------------- HTTP入口 --------------------- */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const isSSE = req.headers.get("accept")?.includes("text/event-stream");

    if (url.pathname === "/api/action" && req.method === "POST") {
      const body = (await req.json()) as
        | { action: "join"; room: number; seat: Seat; sse?: string }
        | { action: "leave"; room: number; sse?: string }
        | { action: "move"; room: number; xy: string }
        | { action: "heartbeat"; room?: number; sse?: string };

      switch (body.action) {
        case "join":
          return this.handleJoin(body.room, body.seat);
        case "leave":
          return this.handleLeave(body.room);
        case "move":
          return this.handleMove(body.room, body.xy);
        case "heartbeat":
          console.log(
            `[SSE] hb room=${body.room ?? "-"} sse=${body.sse ?? "-"}`
          );
          // 何も返さない（情報不要のため200のみ）
          return new Response("OK", { headers: JSONH });
      }
    }

    if (isSSE && url.searchParams.has("room")) {
      const q = url.searchParams;
      const key = q.get("room")!;
      if (key === "all") return this.openLobbySSE();
      const room = clampRoom(parseInt(key, 10));
      const seat = (q.get("seat") as Seat) || "observer";
      return this.openRoomSSE(room, seat);
    }

    return new Response("Not Found", { status: 404 });
  }

  /* ---------------------- ACTIONS ---------------------- */
  private handleJoin(roomN: number, want: Seat): Response {
    const room = this.rooms.get(clampRoom(roomN))!;
    let seat: Seat = "observer";

    if (want === "black" && !room.black) {
      room.black = true;
      seat = "black";
    } else if (want === "white" && !room.white) {
      room.white = true;
      seat = "white";
    } else {
      seat = "observer";
    }

    if (room.black && room.white) {
      room.turn = "black";
      room.status = "black";
      room.board = initBoard(); // 新規対局は初期配置
    } else {
      room.turn = null;
      room.status = "waiting";
    }

    // 放送（ロビー & 部屋）
    this.broadcastLobby();
    this.broadcastRoom(roomN);

    const snapshot = this.snapshotRoom(roomN, seat);
    // X-Play-Tokenはクライアントの既存設計を尊重して残す（ただしSSEでは使わない）
    const token = randomToken();
    return new Response(JSON.stringify(snapshot), {
      headers: { ...JSONH, "x-play-token": token },
    });
  }

  private handleLeave(roomN: number): Response {
    const room = this.rooms.get(clampRoom(roomN))!;
    // 座席の明確な識別がないため「空いていれば触らない」方針 → 明示クリアはロビーのReset DOで行う
    // 試合中断条件にはしない
    // 放送のみ
    this.broadcastLobby();
    this.broadcastRoom(roomN);
    return new Response(null, { status: 204 });
  }

  private handleMove(roomN: number, xy: string): Response {
    const room = this.rooms.get(clampRoom(roomN))!;
    // 今回は手番・合法手判定は省略（元実装をそのまま利用想定）
    // 盤面が変わったと仮定して放送
    room.turn = room.turn === "black" ? "white" : "black";
    room.status = room.turn; // 表示のために同値
    this.broadcastLobby();
    this.broadcastRoom(roomN);
    return new Response("OK", { headers: JSONH });
  }

  /* ------------------- SSE: LOBBY/ROOM ------------------ */
  private openLobbySSE(): Response {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    this.sseAll.add(writer);

    // 部屋ごとの watchers を概算するため、接続時点で部屋0に加算しない
    this.writeEvent(writer, "room_state", JSON.stringify(this.snapshotAll()));

    const pinger = setInterval(() => {
      this.writePing(writer);
    }, 15000);

    const close = () => {
      clearInterval(pinger);
      this.sseAll.delete(writer);
      try {
        writer.releaseLock();
      } catch {}
    };

    (readable as any).closed?.finally?.(close);
    // 旧環境でも確実にクローズされるようフォールバック
    this.state.waitUntil(
      (async () => {
        try {
          await (readable as any).closed;
        } catch {}
        close();
      })()
    );

    return new Response(readable, {
      headers: sseHeaders(),
    });
  }

  private openRoomSSE(roomN: number, _seat: Seat): Response {
    const room = this.rooms.get(clampRoom(roomN))!;
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    let set = this.sseRoom.get(roomN);
    if (!set) this.sseRoom.set(roomN, (set = new Set()));
    set.add(writer);
    room.watchers = set.size;

    // 接続直後にスナップショット
    this.writeEvent(writer, "room_state", JSON.stringify(this.snapshotRoom(roomN, "observer")));
    // ロビーにも反映
    this.broadcastLobby();

    const pinger = setInterval(() => this.writePing(writer), 15000);

    const close = () => {
      clearInterval(pinger);
      set!.delete(writer);
      room.watchers = set!.size;
      this.broadcastLobby(); // 監視者数が変わるのでロビー更新
      try {
        writer.releaseLock();
      } catch {}
    };

    (readable as any).closed?.finally?.(close);
    this.state.waitUntil(
      (async () => {
        try {
          await (readable as any).closed;
        } catch {}
        close();
      })()
    );

    return new Response(readable, { headers: sseHeaders() });
  }

  /* -------------------- SNAPSHOTS/BCAST ------------------ */
  private snapshotRoom(roomN: number, seat: Seat): RoomSnapshot {
    const r = this.rooms.get(clampRoom(roomN))!;
    return {
      room: roomN,
      seat,
      status: r.status,
      turn: r.turn,
      board: r.board,
      legal: [], // 簡略化（必要なら元実装で算出）
      watchers: r.watchers,
    };
  }

  private snapshotAll(): LobbySnapshot {
    const rooms: LobbySnapshot["rooms"] = {};
    for (const [id, r] of this.rooms) {
      rooms[id] = {
        seats: { black: r.black, white: r.white },
        watchers: r.watchers,
        status: r.status,
      };
    }
    return { rooms, ts: Date.now() };
  }

  private broadcastRoom(roomN: number) {
    const set = this.sseRoom.get(clampRoom(roomN));
    if (!set || set.size === 0) return;
    const snap = JSON.stringify(this.snapshotRoom(roomN, "observer"));
    for (const w of set) this.writeEvent(w, "room_state", snap);
  }

  private broadcastLobby() {
    if (this.sseAll.size === 0) return;
    const snap = JSON.stringify(this.snapshotAll());
    for (const w of this.sseAll) this.writeEvent(w, "room_state", snap);
  }

  /* --------------------- SSE helpers --------------------- */
  private writeEvent(
    writer: WritableStreamDefaultWriter,
    event: string,
    data: string
  ) {
    // EventSource仕様に合わせて2改行で区切る
    const chunk = `event: ${event}\n` + `data: ${data}\n\n`;
    writer.write(TEXT.encode(chunk)).catch(() => {});
  }
  private writePing(writer: WritableStreamDefaultWriter) {
    const chunk = `event: ping\n` + `data: ${Date.now()}\n\n`;
    writer.write(TEXT.encode(chunk)).catch(() => {});
  }
}

/* ----------------------------------------------------- */
/* Utilities                                             */
/* ----------------------------------------------------- */
function initBoard(): Board {
  const rows = Array(8)
    .fill("--------")
    .slice();
  // D4=White, E5=White, E4=Black, D5=Black（中心4石）
  rows[3] = "---WB---";
  rows[4] = "---BW---";
  return { size: 8, stones: rows };
}

function clampRoom(n: number) {
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 4) return 4;
  return n | 0;
}

function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  };
}