// functions/api/move.ts  (v0.3)
// - X-Play-Token を検証（seat/room 一致）
// - 空きマスに石を一つ置く簡易ロジック（反転や合法手チェックは未実装）
// - ターン交代、ロビー/該当ルームへ broadcast
// - スナップショット形式で返す

import {
  tokens,
  ensureRoom,
  broadcast,
  Seat,
} from "./_state";

type Turn = "black" | "white" | "-";

const CT_JSON = { "content-type": "application/json; charset=utf-8" } as const;

function bad(status: number, reason: string) {
  return new Response(JSON.stringify({ ok: false, reason }), {
    status,
    headers: new Headers(CT_JSON),
  });
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

export const onRequestPost: PagesFunction = async (context) => {
  const { request } = context;

  // body
  const body = await request.json().catch(() => ({}));
  const room = Number(body?.room);
  const seat = String(body?.seat || "") as Seat; // "black"|"white"
  const pos = String(body?.pos || "");

  if (![1, 2, 3, 4].includes(room)) return bad(400, "invalid_room");
  if (seat !== "black" && seat !== "white") return bad(400, "invalid_seat");
  const p = parsePos(pos);
  if (!p) return bad(400, "invalid_pos");

  // token 検証
  const token = request.headers.get("X-Play-Token") || "";
  if (!token || !tokens.has(token)) return bad(401, "no_token");
  const tok = tokens.get(token)!;
  if (tok.room !== room) return bad(403, "room_mismatch");
  if (tok.seat !== seat) return bad(403, "seat_mismatch");

  // 盤面取得
  const r = ensureRoom(room);

  // 手番チェック
  const turn = r.turn as Turn;
  if (turn !== seat) return bad(409, "not_your_turn");

  // 置けるか（簡易：空きのみ判定）
  const row = r.board.stones[p.y];
  if (!row || row[p.x] !== "-") return bad(409, "occupied");

  // === 着手（簡易：反転は未実装） ===
  const stone = seat === "black" ? "B" : "W";
  r.board.stones[p.y] = setChar(row, p.x, stone);

  // ターン交代
  r.turn = seat === "black" ? "white" : "black";
  r.status = r.turn; // "black" or "white"

  // 初手ログ用（任意）：開始前が4石のみだったら first-move
  const countBefore =
    r.board.stones.join("").split("").filter((c) => c === "B" || c === "W").length;
  // countBefore は「着手後」のカウントなので厳密な初手検出には before/after を保持する必要があります。
  // ここではログヘッダは付けず、必要になったら _state 側に履歴を持たせてください。

  // ブロードキャスト（ロビー＋該当ルーム）
  broadcast(room);

  // レスポンス（スナップショット）
  const resBody = {
    room,
    seat,                               // 呼び出し側の自席
    status: r.status,                    // "black" | "white" | "waiting" | ...
    turn: r.turn === "-" ? null : r.turn,
    board: r.board,
    legal: [],                           // 未実装
    watchers: r.watchers,
  };

  return new Response(JSON.stringify(resBody), {
    status: 200,
    headers: new Headers(CT_JSON),
  });
};