// functions/api/_state.ts
export type Seat = "black" | "white" | "observer";
export type SeatOccupy = "vacant" | "taken";

export type RoomState = {
  room: number;
  seats: { black: SeatOccupy; white: SeatOccupy };
  watchers: number;
  status: "waiting" | "black" | "white" | "leave" | "finished";
  turn: "black" | "white" | "-";
  board: { size: number; stones: string[] };
};

export type Snapshot = {
  room: number;
  seat: Seat;
  status: RoomState["status"];
  turn: "black" | "white" | null;
  board: { size: number; stones: string[] };
  legal: string[];
  watchers?: number;
};

// ---- global (isolate内だけ) -----------------------------------
const g: any = (globalThis as any);
if (!g.__REV_STATE__) {
  g.__REV_STATE__ = {
    rooms: new Map<number, RoomState>(),
    lobbySubs: new Set<(s: string) => void>(),
    roomSubs: new Map<number, Set<(s: string) => void>>(),
    tokens: new Map<string, { room: number; seat: Seat }>(),
  };
}
export const rooms: Map<number, RoomState> = g.__REV_STATE__.rooms;
const lobbySubs: Set<(s: string) => void> = g.__REV_STATE__.lobbySubs;
const roomSubs: Map<number, Set<(s: string) => void>> = g.__REV_STATE__.roomSubs;
export const tokens: Map<string, { room: number; seat: Seat }> = g.__REV_STATE__.tokens;

// ---- board helpers --------------------------------------------
export function emptyBoard(): string[] {
  return Array.from({ length: 8 }, () => "-".repeat(8));
}
export function startingBoard(): string[] {
  const b = emptyBoard();
  b[3] = "---WB---";
  b[4] = "---BW---";
  return b;
}

export function ensureRoom(room: number): RoomState {
  let r = rooms.get(room);
  if (!r) {
    r = {
      room,
      seats: { black: "vacant", white: "vacant" },
      watchers: 0,
      status: "waiting",
      turn: "-",
      board: { size: 8, stones: startingBoard() },
    };
    rooms.set(room, r);
  }
  return r;
}

// ---- subscribe / broadcast ------------------------------------
export function subscribeLobby(write: (s: string) => void, signal: AbortSignal) {
  lobbySubs.add(write);
  signal.addEventListener("abort", () => lobbySubs.delete(write));
}

export function subscribeRoom(room: number, write: (s: string) => void, signal: AbortSignal) {
  if (!roomSubs.has(room)) roomSubs.set(room, new Set());
  const set = roomSubs.get(room)!;
  set.add(write);
  signal.addEventListener("abort", () => set.delete(write));
}

export function broadcast(room?: number) {
  // lobby snapshot
  const lobby = JSON.stringify(getLobbySnapshot());
  for (const w of lobbySubs) w(`event: room_state\ndata: ${lobby}\n\n`);
  if (room) {
    const snap = JSON.stringify(getRoomSnapshot(room));
    for (const w of roomSubs.get(room) ?? []) w(`event: room_state\ndata: ${snap}\n\n`);
  }
}

// ---- snapshots ------------------------------------------------
export function getLobbySnapshot() {
  const boards = [1, 2, 3, 4].map((n) => {
    const r = ensureRoom(n);
    return {
      room: n,
      seats: r.seats,
      watchers: r.watchers,
      status: r.status,
      turn: r.turn,
    };
  });
  return { ts: Date.now(), scope: "lobby", room: "all", state: { boards } };
}

export function getRoomSnapshot(room: number) {
  const r = ensureRoom(room);
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

// ---- game-state mutation (join/leave hooks) -------------------
export function applyJoin(room: number, requested: Seat): Seat {
  const r = ensureRoom(room);
  let seat = requested;
  if (requested === "black") {
    if (r.seats.black === "taken") seat = "observer";
    else r.seats.black = "taken";
  } else if (requested === "white") {
    if (r.seats.white === "taken") seat = "observer";
    else r.seats.white = "taken";
  }
  if (seat === "observer") r.watchers++;
  // start condition
  if (r.seats.black === "taken" && r.seats.white === "taken") {
    r.status = "black";
    r.turn = "black";
  } else {
    r.status = "waiting";
    r.turn = "-";
  }
  return seat;
}

export function applyLeave(room: number, seat: Seat) {
  const r = ensureRoom(room);
  if (seat === "black") r.seats.black = "vacant";
  else if (seat === "white") r.seats.white = "vacant";
  else if (seat === "observer") r.watchers = Math.max(0, r.watchers - 1);

  // board reset when a player leaves
  if (seat === "black" || seat === "white") {
    r.board.stones = startingBoard();
    r.status = "leave";           // UI: popup → waiting へ
    r.turn = "-";
  } else {
    // spectator leave doesn't change status/turn
    if (r.seats.black !== "taken" || r.seats.white !== "taken") {
      r.status = "waiting";
      r.turn = "-";
    }
  }
}
 
// ---- tokens ---------------------------------------------------
export function makeToken(len = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}