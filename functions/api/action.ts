// functions/api/action.ts
import {
  tokens,
  makeToken,
  startingBoard,
  applyJoin,
  applyLeave,
  getRoomSnapshot,
  broadcast,
  Seat,
} from "./_state";

export const onRequestPost: PagesFunction = async (context) => {
  const { request } = context;
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || "");
  const room = Number(body?.room);
  const requestedSeat = String(body?.seat || "observer") as Seat;

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });

  if (action === "join") {
    // 更新
    const finalSeat = applyJoin(room, requestedSeat);

    // token
    const token = makeToken(8);
    tokens.set(token, { room, seat: finalSeat });
    headers.set("X-Play-Token", token);

    // ブロードキャスト（ロビー＋該当ルーム）
    broadcast(room);

    // レスポンス（スナップショット）
    const snap = getRoomSnapshot(room);
    // 呼び出し側の自席を入れて返す
    (snap as any).seat = finalSeat;
    return new Response(JSON.stringify(snap), { headers, status: 200 });
  }

  if (action === "leave") {
    // token / seat 判定
    const token = request.headers.get("X-Play-Token") || "";
    let seat: Seat = requestedSeat;
    if (token && tokens.has(token)) seat = tokens.get(token)!.seat;
    if (token) {
      tokens.delete(token);
      headers.set("X-Log-Event", "token-deleted");
      headers.set("X-Token", token);
    }

    applyLeave(room, seat);
    broadcast(room);

    const snap = getRoomSnapshot(room);
    (snap as any).seat = seat;
    return new Response(JSON.stringify(snap), { headers, status: 200 });
  }

  return new Response(JSON.stringify({ ok: false, reason: "unsupported_action" }), {
    headers,
    status: 400,
  });
};