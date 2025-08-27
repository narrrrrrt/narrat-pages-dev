// workers/do-worker/worker.ts  -- v0.4
// ReversiHub: 状態 + 購読 + broadcast を単一インスタンスで管理
export interface Env {}

type Seat = "black" | "white" | "observer";
type SeatOccupy = "vacant" | "taken";
type Turn = "black" | "white" | "-";

type RoomState = {
  room: number;
  seats: { black: SeatOccupy; white: SeatOccupy };
  watchers: number;
  status: "waiting" | "black" | "white" | "leave" | "finished";
  turn: Turn;
  board: { size: number; stones: string[] };
};

function emptyBoard(): string[] {
  return Array.from({ length: 8 }, () => "-".repeat(8));
}
function startingBoard(): string[] {
  const b = emptyBoard();
  b[3] = "---WB---";
  b[4] = "---BW---";
  return b;
}

function parsePos(pos: string): { x: number; y: number } | null {
  if (!/^[a-h][1-8]$/.test(pos)) return null;
  const x = pos.charCodeAt(0) - "a".charCodeAt(0);
  const y = Number(pos[1]) - 1;
  return { x, y };
}
function setChar(s: string, i: number, ch: string) {
  return s.slice(0, i) + ch + s.slice(i + 1);
}

class SSEConn {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  enc = new TextEncoder();
  pingTimer?: any;
  room: "all" | number;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>, room: "all" | number) {
    this.writer = writer;
    this.room = room;
  }
  write(s: string) {
    return this.writer.write(this.enc.encode(s));
  }
  send(event: string, data: any) {
    this.write(`event: ${event}\n`);
    this.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  startHeartbeat() {
    this.pingTimer = setInterval(() => {
      this.write(`: ping ${Date.now()}\n\n`);
    }, 3000);
  }
  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    try { this.writer.close(); } catch {}
  }
}

export class ReversiHub {
  state: DurableObjectState;
  env: Env;

  // 揮発状態（メモリ）
  rooms = new Map<number, RoomState>();
  tokens = new Map<string, { room: number; seat: Seat }>();
  lobbySubs = new Set<SSEConn>();
  roomSubs = new Map<number, Set<SSEConn>>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // 初期化
    for (const n of [1, 2, 3, 4]) {
      this.rooms.set(n, {
        room: n,
        seats: { black: "vacant", white: "vacant" },
        watchers: 0,
        status: "waiting",
        turn: "-",
        board: { size: 8, stones: startingBoard() },
      });
    }
  }

  // === ユーティリティ ===
  ensureRoom(n: number): RoomState {
    let r = this.rooms.get(n);
    if (!r) {
      r = {
        room: n,
        seats: { black: "vacant", white: "vacant" },
        watchers: 0,
        status: "waiting",
        turn: "-",
        board: { size: 8, stones: startingBoard() },
      };
      this.rooms.set(n, r);
    }
    return r;
  }

  lobbySnapshot() {
    const boards = [1, 2, 3, 4].map((n) => {
      const r = this.ensureRoom(n);
      return { room: n, seats: r.seats, watchers: r.watchers, status: r.status, turn: r.turn };
    });
    return { ts: Date.now(), scope: "lobby", room: "all", state: { boards } };
  }
  roomSnapshot(room: number) {
    const r = this.ensureRoom(room);
    return {
      room,
      seat: "observer",
      status: r.status,
      turn: r.turn === "-" ? null : (r.turn as "black" | "white" | null),
      board: r.board,
      legal: [],
      watchers: r.watchers,
    };
  }

  broadcast(room?: number) {
    const lobby = this.lobbySnapshot();
    for (const c of this.lobbySubs) c.send("room_state", lobby);
    if (room) {
      const snap = this.roomSnapshot(room);
      for (const c of this.roomSubs.get(room) ?? []) c.send("room_state", snap);
    }
  }

  makeToken(len = 8) {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[buf[i] % alphabet.length];
    return s;
  }

  applyJoin(room: number, requested: Seat): Seat {
    const r = this.ensureRoom(room);
    let seat = requested;
    if (requested === "black") {
      if (r.seats.black === "taken") seat = "observer"; else r.seats.black = "taken";
    } else if (requested === "white") {
      if (r.seats.white === "taken") seat = "observer"; else r.seats.white = "taken";
    }
    if (seat === "observer") r.watchers++;

    if (r.seats.black === "taken" && r.seats.white === "taken") {
      r.status = "black"; r.turn = "black";
    } else { r.status = "waiting"; r.turn = "-"; }
    return seat;
  }

  applyLeave(room: number, seat: Seat) {
    const r = this.ensureRoom(room);
    if (seat === "black") r.seats.black = "vacant";
    else if (seat === "white") r.seats.white = "vacant";
    else if (seat === "observer") r.watchers = Math.max(0, r.watchers - 1);

    if (seat === "black" || seat === "white") {
      r.board.stones = startingBoard();
      r.status = "leave";
      r.turn = "-";
    } else {
      if (r.seats.black !== "taken" || r.seats.white !== "taken") {
        r.status = "waiting";
        r.turn = "-";
      }
    }
  }

  // === ルーティング ===
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/sse") return this.handleSSE(request, url);
    if (path === "/action" && request.method === "POST") return this.handleAction(request);
    if (path === "/move"   && request.method === "POST") return this.handleMove(request);
    if (path === "/admin" && request.method === "POST") return this.handleAdminReset();
    return new Response("ReversiHub", { status: 200 });
  }

  // === SSE ===
  async handleSSE(request: Request, url: URL): Promise<Response> {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const roomParam = url.searchParams.get("room") || "all";
    const room: "all" | number = roomParam === "all" ? "all" : Number(roomParam);
    const conn = new SSEConn(writer, room);

    // 初回スナップショット
    if (room === "all") conn.send("room_state", this.lobbySnapshot());
    else conn.send("room_state", this.roomSnapshot(room));

    // 登録
    if (room === "all") this.lobbySubs.add(conn);
    else {
      if (!this.roomSubs.has(room)) this.roomSubs.set(room, new Set());
      this.roomSubs.get(room)!.add(conn);
    }

    // 心拍 & 切断ハンドリング
    conn.startHeartbeat();
    const cleanup = () => {
      conn.stop();
      if (room === "all") this.lobbySubs.delete(conn);
      else this.roomSubs.get(room)?.delete(conn);
    };
    // CloudflareのAbortSignal
    try { request.signal.addEventListener("abort", cleanup); } catch {}
    // 予防的に30分でクローズ
    setTimeout(cleanup, 30 * 60 * 1000);

    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "pragma": "no-cache",
      },
    });
  }

  // === /action（join/leave） ===
  async handleAction(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({} as any));
    const action = String(body?.action || "");
    const room = Number(body?.room);
    const reqSeat = String(body?.seat || "observer") as Seat;

    if (!room || ![1,2,3,4].includes(room)) {
      return json({ ok:false, reason:"invalid_room" }, 400);
    }

    if (action === "join") {
      const seat = this.applyJoin(room, reqSeat);
      const token = this.makeToken(8);
      this.tokens.set(token, { room, seat });
      this.broadcast(room);

      const snap = this.roomSnapshot(room) as any;
      snap.seat = seat;
      return json(snap, 200, { "X-Play-Token": token });
    }

    if (action === "leave") {
      const token = request.headers.get("X-Play-Token") || "";
      let seat = reqSeat;
      if (token && this.tokens.has(token)) seat = this.tokens.get(token)!.seat;
      if (token) this.tokens.delete(token);

      this.applyLeave(room, seat);
      this.broadcast(room);

      const snap = this.roomSnapshot(room) as any;
      snap.seat = seat;
      return json(snap);
    }

    return json({ ok:false, reason:"unsupported_action" }, 400);
  }

  // === /move（簡易：空きのみ判定） ===
  async handleMove(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({} as any));
    const room = Number(body?.room);
    const seat = String(body?.seat || "") as Seat;
    const pos  = String(body?.pos  || "");

    if (!room || ![1,2,3,4].includes(room)) return json({ ok:false, reason:"invalid_room" }, 400);
    if (seat !== "black" && seat !== "white") return json({ ok:false, reason:"invalid_seat" }, 400);
    const p = parsePos(pos);
    if (!p) return json({ ok:false, reason:"invalid_pos" }, 400);

    const token = request.headers.get("X-Play-Token") || "";
    if (!token || !this.tokens.has(token)) return json({ ok:false, reason:"no_token" }, 401);
    const tk = this.tokens.get(token)!;
    if (tk.room !== room)  return json({ ok:false, reason:"room_mismatch" }, 403);
    if (tk.seat !== seat)  return json({ ok:false, reason:"seat_mismatch" }, 403);

    const r = this.ensureRoom(room);
    if (r.turn !== seat) return json({ ok:false, reason:"not_your_turn" }, 409);

    const row = r.board.stones[p.y];
    if (!row || row[p.x] !== "-") return json({ ok:false, reason:"occupied" }, 409);

    const stone = seat === "black" ? "B" : "W";
    r.board.stones[p.y] = setChar(row, p.x, stone);

    r.turn = seat === "black" ? "white" : "black";
    r.status = r.turn;

    this.broadcast(room);

    const snap = this.roomSnapshot(room) as any;
    snap.seat = seat;
    return json(snap, 200);
  }

  // === /admin（全初期化：デバッグ用） ===
  async handleAdminReset(): Promise<Response> {
    this.tokens.clear();
    this.rooms.clear();
    for (const n of [1,2,3,4]) {
      this.rooms.set(n, {
        room: n,
        seats: { black: "vacant", white: "vacant" },
        watchers: 0,
        status: "waiting",
        turn: "-",
        board: { size: 8, stones: startingBoard() },
      });
    }
    this.broadcast(undefined);
    for (const n of [1,2,3,4]) this.broadcast(n);
    return json(this.lobbySnapshot(), 200);
  }
}

// ---- helpers ----
function json(obj: any, status = 200, extraHeaders: Record<string,string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// 末尾に追加（既存の ReversiHub クラスはそのまま）
// これで "modules" ワーカーとしてビルドされ、DO が有効化されます。
export default {
  async fetch(_req: Request): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, note: "ReversiHub DO" }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};