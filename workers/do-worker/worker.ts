// workers/do-worker/worker.ts
// Reversi Durable Object (DO)
// v1.1.5-fix: lobby seats flags, lobby broadcast on join/leave, watchers count, no ping

export interface Env {
  REVERSI_HUB: DurableObjectNamespace;
}

type Seat = "black" | "white" | "observer";
type Status = "waiting" | "black" | "white" | "leave" | "finished";

type Board = {
  size: number;
  stones: string[]; // 8 lines of "--------", "----WB--", etc.
};

type RoomState = {
  status: Status;
  turn: "black" | "white" | null;
  board: Board;
  legal: string[];
  watchers: number;
};

type SnapshotRoom = {
  room: number;
  seat: Seat;
} & RoomState;

type SnapshotLobby = {
  rooms: Record<
    string,
    {
      seats: { black: boolean; white: boolean }; // Vacant flags
      watchers: number;
      status: Status;
    }
  >;
  ts: number;
};

type SseClient = {
  controller: ReadableStreamDefaultController<Uint8Array>;
};

type TokenInfo = {
  token: string;
  room: number;
  seat: Seat; // black | white | observer
};

type RoomData = {
  blackToken?: string;
  whiteToken?: string;
  status: Status;
  turn: "black" | "white" | null;
  board: Board;
  legal: string[];
  watchers: Set<SseClient>;
};

function enc(s: string) {
  return new TextEncoder().encode(s);
}

function initBoard(): Board {
  return {
    size: 8,
    stones: [
      "--------",
      "--------",
      "--------",
      "---WB---",
      "---BW---",
      "--------",
      "--------",
      "--------",
    ],
  };
}

export class ReversiHub {
  state: DurableObjectState;
  rooms: Map<number, RoomData>;
  tokenMap: Map<string, TokenInfo>;
  lobbyWatchers: Set<SseClient>;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.rooms = new Map();
    this.tokenMap = new Map();
    this.lobbyWatchers = new Set();
    // init 4 rooms
    for (let n = 1; n <= 4; n++) {
      this.rooms.set(n, {
        status: "waiting",
        turn: null,
        board: initBoard(),
        legal: [],
        watchers: new Set(),
      });
    }
  }

  // ---------------- routing ----------------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Admin reset (test only)
    if (pathname === "/admin" && req.method === "POST") {
      this.resetAll();
      this.broadcastLobby();
      for (let n = 1; n <= 4; n++) this.broadcastRoom(n);
      return new Response("OK", { status: 200 });
    }

    // SSE
    if (req.headers.get("accept") === "text/event-stream") {
      const roomParam = url.searchParams.get("room");
      if (roomParam === "all") return this.handleSseLobby();
      const n = parseInt(roomParam || "0", 10);
      const seat = (url.searchParams.get("seat") || "observer") as Seat;
      if (n >= 1 && n <= 4) return this.handleSseRoom(n, seat);
      return new Response("Bad room", { status: 400 });
    }

    // API
    if (pathname === "/api/action" && req.method === "POST") {
      return this.handleAction(req);
    }
    if (pathname === "/api/move" && req.method === "POST") {
      return this.handleMove(req);
    }

    return new Response("Not found", { status: 404 });
  }

  // ---------------- utilities ----------------

  private randomToken(): string {
    const s = Math.random().toString(36).slice(2, 10);
    return s;
  }

  private snapshotRoom(n: number, seat: Seat): SnapshotRoom {
    const r = this.rooms.get(n)!;
    return {
      room: n,
      seat,
      status: r.status,
      turn: r.turn,
      board: r.board,
      legal: r.legal,
      watchers: r.watchers.size,
    };
  }

  private snapshotLobby(): SnapshotLobby {
    const rooms: SnapshotLobby["rooms"] = {};
    for (const [n, r] of this.rooms) {
      rooms[String(n)] = {
        seats: {
          // Vacant flags: 空いている = true（トークン無し）
          black: !r.blackToken,
          white: !r.whiteToken,
        },
        watchers: r.watchers.size,
        status: r.status ?? "waiting",
      };
    }
    return { rooms, ts: Date.now() };
  }

  private sseHeaders(): Headers {
    const h = new Headers();
    h.set("content-type", "text/event-stream");
    h.set("cache-control", "no-cache");
    h.set("connection", "keep-alive");
    return h;
  }

  private sendEvent(c: SseClient, event: string, data: any) {
    const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
    try {
      c.controller.enqueue(enc(payload));
    } catch {
      // ignore
    }
  }

  private broadcastRoom(n: number) {
    const r = this.rooms.get(n)!;
    const snap = this.snapshotRoom(n, "observer");
    for (const c of r.watchers) this.sendEvent(c, "room_state", snap);
  }

  private broadcastLobby() {
    const snap = this.snapshotLobby();
    for (const c of this.lobbyWatchers) this.sendEvent(c, "room_state", snap);
  }

  private resetAll() {
    this.tokenMap.clear();
    for (let n = 1; n <= 4; n++) {
      const r = this.rooms.get(n)!;
      r.blackToken = undefined;
      r.whiteToken = undefined;
      r.status = "waiting";
      r.turn = null;
      r.board = initBoard();
      r.legal = [];
      // watchers は接続中のSSEなので触らない
    }
  }

  // ---------------- SSE handlers ----------------

  private handleSseLobby(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const client: SseClient = { controller };
        this.lobbyWatchers.add(client);
        // 接続直後にスナップショット
        this.sendEvent(client, "room_state", this.snapshotLobby());
        // 接続増減をロビーへ反映（人数）
        this.broadcastLobby();

        // 切断時
        const drop = () => {
          if (this.lobbyWatchers.delete(client)) {
            this.broadcastLobby();
          }
        };
        // Cloudflare DO では close/cancelは自前管理
        (controller as any).signal?.addEventListener?.("abort", drop);
      },
      cancel: () => {
        // nop（上で処理）
      },
    });
    return new Response(stream, this.sseHeaders());
  }

  private handleSseRoom(n: number, _seat: Seat): Response {
    const r = this.rooms.get(n)!;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const client: SseClient = { controller };
        r.watchers.add(client);
        // 接続直後に部屋スナップショット
        this.sendEvent(client, "room_state", this.snapshotRoom(n, "observer"));
        // ロビー（watchers数）も反映
        this.broadcastLobby();

        const drop = () => {
          if (r.watchers.delete(client)) {
            this.broadcastLobby();
          }
        };
        (controller as any).signal?.addEventListener?.("abort", drop);
      },
    });
    return new Response(stream, this.sseHeaders());
  }

  // ---------------- API: action ----------------

  private async handleAction(req: Request): Promise<Response> {
    // Heartbeat: empty body + X-Play-Token
    const token = req.headers.get("x-play-token") || "";
    if (token && (!req.headers.get("content-length") || (await req.clone().text()).trim() === "")) {
      // Step1: HBは受理だけ（TTL監視は別フェーズでも可）
      return new Response(null, { status: 204 });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action as "join" | "leave";

    if (action === "join") {
      const room = Number(body.room || 0);
      const seat = (body.seat || "observer") as Seat;
      const sseId = String(body.sse || "");
      return this.join(room, seat, sseId);
    }

    if (action === "leave") {
      const room = Number(body.room || 0);
      const sseId = String(body.sse || "");
      return this.leave(room, sseId, token);
    }

    return new Response("bad action", { status: 400 });
  }

  private join(roomNo: number, seat: Seat, _sseId: string): Response {
    const r = this.rooms.get(roomNo);
    if (!r) return new Response("bad room", { status: 400 });

    let grantedSeat: Seat = "observer";
    let tok = this.randomToken();

    if (seat === "black" && !r.blackToken) {
      r.blackToken = tok;
      r.status = r.whiteToken ? "black" : "waiting";
      r.turn = r.whiteToken ? "black" : null;
      grantedSeat = "black";
    } else if (seat === "white" && !r.whiteToken) {
      r.whiteToken = tok;
      r.status = r.blackToken ? "black" : "waiting";
      r.turn = r.blackToken ? "black" : null;
      grantedSeat = "white";
    } else {
      // 観戦
      grantedSeat = "observer";
      tok = this.randomToken();
    }

    this.tokenMap.set(tok, { token: tok, room: roomNo, seat: grantedSeat });

    // ルーム & ロビーへ配信（← 重要）
    this.broadcastRoom(roomNo);
    this.broadcastLobby();

    const snap = this.snapshotRoom(roomNo, grantedSeat);
    const h = new Headers({ "content-type": "application/json" });
    h.set("X-Play-Token", tok);
    return new Response(JSON.stringify(snap), { status: 200, headers: h });
  }

  private leave(roomNo: number, sseId: string, tokenHeader: string): Response {
    // sseId は beacon 用の名残。ここでは未使用でもOK。
    const tok = tokenHeader || "";
    const info = tok ? this.tokenMap.get(tok) : undefined;
    const r = this.rooms.get(roomNo);
    if (!r) return new Response("bad room", { status: 400 });

    if (info && info.room === roomNo) {
      if (info.seat === "black" && r.blackToken === tok) r.blackToken = undefined;
      if (info.seat === "white" && r.whiteToken === tok) r.whiteToken = undefined;
      this.tokenMap.delete(tok);
      // ステータス更新
      if (!r.blackToken && !r.whiteToken) {
        r.status = "waiting";
        r.turn = null;
      } else if (r.blackToken && !r.whiteToken) {
        r.status = "waiting";
        r.turn = null;
      } else if (!r.blackToken && r.whiteToken) {
        r.status = "waiting";
        r.turn = null;
      }
    }

    // ルーム & ロビーへ配信（← 重要）
    this.broadcastRoom(roomNo);
    this.broadcastLobby();

    const snap = this.snapshotRoom(roomNo, "observer");
    return new Response(JSON.stringify(snap), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // ---------------- API: move（簡易／盤面ロジックは既存のまま想定） ----------------

  private async handleMove(req: Request): Promise<Response> {
    const token = req.headers.get("x-play-token") || "";
    const info = token ? this.tokenMap.get(token) : undefined;
    if (!info || (info.seat !== "black" && info.seat !== "white"))
      return new Response("forbidden", { status: 403 });

    const body = await req.json().catch(() => ({}));
    const pos = String(body.pos || "");
    const r = this.rooms.get(info.room)!;

    // ここは既存実装のまま（盤面更新→合法手更新→ターン交代）
    // ダミーでターンだけ交代
    if (r.turn === "black") r.turn = "white";
    else r.turn = "black";
    r.status = r.turn === "black" ? "black" : "white";

    const snap = this.snapshotRoom(info.room, info.seat);

    // ルーム & ロビーへ配信（turnはロビーUIでも使う想定なら）
    this.broadcastRoom(info.room);
    this.broadcastLobby();

    return new Response(JSON.stringify(snap), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;