// functions/api/_state.ts
// In-memory demo state. For production, move to Durable Objects or KV.
export type Seat = "black" | "white" | "observer";
export type Snapshot = {
  room: number,
  seat: Seat,
  status: "waiting"|"black"|"white"|"leave"|"finished",
  turn: "black"|"white"|null,
  board: { size: number, stones: string[] },
  legal: string[],
  watchers?: number
};

const globalAny = globalThis as any;
if (!globalAny.__REVERSI_STATE__) {
  globalAny.__REVERSI_STATE__ = {
    movesByRoom: new Map<number, number>(),
    tokens: new Map<string, {room:number, seat:Seat}>()
  };
}
export const movesByRoom: Map<number, number> = (globalAny.__REVERSI_STATE__.movesByRoom);
export const tokens: Map<string, {room:number, seat:Seat}> = (globalAny.__REVERSI_STATE__.tokens);

// Helper
export function makeToken(len=8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  const cryptoObj: Crypto = crypto;
  const buf = new Uint8Array(len);
  cryptoObj.getRandomValues(buf);
  for (let i=0;i<len;i++){ s += alphabet[buf[i]%alphabet.length]; }
  return s;
}

export function emptyBoard(): string[] {
  return Array.from({length:8},()=>"-".repeat(8));
}

export function startingBoard(): string[] {
  const b = emptyBoard();
  // D4=白 (W), E4=黒 (B), D5=黒 (B), E5=白 (W)
  // Using 0-based indices: row3 col3 = d4 etc, but we'll just set strings quickly.
  b[3] = "---WB---";
  b[4] = "---BW---";
  return b;
}

export function snapshot(room:number, seat:Seat, status:"waiting"|"black"|"white"|"leave"|"finished", turn:"black"|"white"|null, stones:string[], legal:string[], watchers=0): Snapshot {
  return { room, seat, status, turn, board: { size: 8, stones }, legal, watchers };
}
