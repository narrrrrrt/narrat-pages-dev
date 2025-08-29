// public/js/reverse.js -- v1.1.6-debug (JOIN→SSE/room=<n> を監視しつつデバッグ表示)

(function () {
  // 便利関数
  const $ = (s) => document.querySelector(s);
  const now = () => new Date().toTimeString().slice(0, 8);
  const qs = (k) => {
    const u = new URL(location.href);
    return u.searchParams.get(k);
  };
  const randId = () => Math.random().toString(16).slice(2, 10);

  // 画面要素
  const elRoom = $("#room");
  const elSeat = $("#seat");
  const elTurn = $("#turn");
  const elStatus = $("#status");
  const elWatchers = $("#watchers");
  const elBoard = $("#board");
  const elDebug = $("#debug");

  // 状態
  const room = Math.max(1, Math.min(4, parseInt(qs("room") || "1", 10)));
  const wantSeat = (qs("seat") || "observer").toLowerCase(); // "black"/"white"/"observer"
  const sseId = randId();
  let token = "";
  let es = null;

  elRoom.textContent = String(room);
  elSeat.textContent = wantSeat;

  const log = (label, obj) => {
    const header = `[${now()}] ${label}\n`;
    if (typeof obj === "string") {
      elDebug.textContent += header + obj + "\n\n";
    } else {
      elDebug.textContent += header + JSON.stringify(obj, null, 2) + "\n\n";
    }
    elDebug.scrollTop = elDebug.scrollHeight;
  };

  // 盤面描画（stones が配列のときのみ描画）←ここが以前逆条件になっていた
  function renderBoard(board) {
    if (!board || !Array.isArray(board.stones)) return; // ← 修正ポイント
    const size = board.size || 8;
    const tbl = document.createElement("table");
    const tbody = document.createElement("tbody");

    for (let y = 0; y < size; y++) {
      const tr = document.createElement("tr");
      for (let x = 0; x < size; x++) {
        const td = document.createElement("td");
        const ch = (board.stones[y] || "-").charAt(x) || "-";
        if (ch === "B" || ch === "W") {
          const s = document.createElement("div");
          s.className = "stone " + (ch === "B" ? "black" : "white");
          td.appendChild(s);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    elBoard.innerHTML = "";
    elBoard.appendChild(tbl);
  }

  // HUD 反映
  function applySnapshot(snap) {
    if (!snap) return;
    if (snap.status) elStatus.textContent = snap.status;
    if (typeof snap.turn !== "undefined" && snap.turn !== null) {
      elTurn.textContent = snap.turn === "black" ? "●" : snap.turn === "white" ? "○" : "-";
    }
    if (typeof snap.watchers === "number") elWatchers.textContent = String(snap.watchers);
    if (snap.board) renderBoard(snap.board);
  }

  // JOIN → token 取得 → 初期盤面反映 → SSE 接続
  async function joinAndListen() {
    // JOIN body（送信前ログ）
    const body = { action: "join", room, seat: wantSeat, sse: sseId };
    log("JOIN body", body);

    // 送信
    let res;
    try {
      res = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      log("JOIN fetch error", String(e));
      return;
    }

    // レスポンス（raw 先頭512B）とヘッダ
    const raw = await res.text();
    log("JOIN response raw(<=512B)", raw.slice(0, 512));
    token = res.headers.get("X-Play-Token") || "";
    log("JOIN response header", { status: res.status, token: token ? token : "(none)" });

    // 初期スナップショットを適用（200 のときのみ）
    try {
      if (res.ok) {
        const snap = JSON.parse(raw);
        applySnapshot(snap);
      }
    } catch (_) {
      /* noop: raw が JSON でないケースも許容（仕様上はJSONのはず） */
    }

    // SSE 接続（room 固定で監視。seat/sse はサーバ側で利用しているなら付与）
    const url = `/?room=${room}&seat=${encodeURIComponent(wantSeat)}&sse=${encodeURIComponent(sseId)}`;
    es = new EventSource(url);
    es.addEventListener("open", () => log("SSE open", url));
    es.addEventListener("error", () => log("SSE error", "(auto-retry by browser)"));
    es.addEventListener("room_state", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        log("SSE room_state", data); // デバッグ欄へそのまま
        // 自分の部屋だけ抜き出して反映（/room=all を受けた場合に備えても安全）
        const myRoom =
          data.room === room ? data : // /?room=1 形式
          data.rooms && data.rooms[String(room)] ? data.rooms[String(room)] : null; // /?room=all 形式
        if (myRoom) {
          // ロビー形式なら正規化（最低限のキーのみ）
          applySnapshot({
            status: myRoom.status,
            turn: myRoom.turn,
            board: myRoom.board,
            watchers: typeof myRoom.watchers === "number" ? myRoom.watchers : 0,
          });
        }
      } catch (e) {
        log("SSE parse error", String(e));
      }
    });

    // ページ離脱時に早期退室（既存仕様のまま）
    const beacon = () => {
      try {
        navigator.sendBeacon("/api/action", JSON.stringify({ action: "leave", room, sse: sseId }));
      } catch (_) {}
    };
    window.addEventListener("pagehide", beacon);
    window.addEventListener("beforeunload", beacon);
  }

  // 起動
  document.addEventListener("DOMContentLoaded", () => {
    joinAndListen();
  });
})();