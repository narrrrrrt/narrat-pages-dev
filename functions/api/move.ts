// functions/api/move.ts
import { movesByRoom, tokens, snapshot, startingBoard } from "./_state";

export const onRequestPost: PagesFunction = async (context) => {
  const { request } = context;
  const body = await request.json().catch(()=> ({}));
  const room = Number(body?.room);
  const seat = String(body?.seat || "");
  const pos = String(body?.pos || "");

  // Identify token (demo via cookie)
  const cookie = request.headers.get("cookie") || "";
  const m = /(?:^|;\s*)rtok=([^;]+)/.exec(cookie);
  const token = m ? decodeURIComponent(m[1]) : "";

  let headers = new Headers({ "content-type": "application/json; charset=utf-8" });

  // naive move counter to detect "first move"
  const prev = movesByRoom.get(room) || 0;
  const now = prev + 1;
  movesByRoom.set(room, now);
  if (prev === 0) {
    headers.set("X-Log-Event", "first-move");
    headers.set("X-Seat", seat);
    headers.set("X-Room", String(room));
    headers.set("X-Token", token);
  }

  // Build a minimal next-state snapshot (stubbed logic)
  // Toggle turn: if black moved, next is white; else black.
  const nextStatus = seat === "black" ? "white" : "black";
  const nextTurn = seat === "black" ? "white" : "black";

  const snap = snapshot(room, seat as any, nextStatus as any, nextTurn as any, startingBoard(), ["c3","e3","c5"], 0);
  return new Response(JSON.stringify(snap), { headers, status: 200 });
};
