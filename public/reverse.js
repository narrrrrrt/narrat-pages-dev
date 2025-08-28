// v0.9a  reverse.js  (room page only)
(() => {
  const $ = (q) => document.querySelector(q);

  // --- i18n minimal ---
  const i18n = { opponent_left: "Opponent left the game." };
  fetch("/i18n/system_messages.json").then(r => r.ok ? r.json() : null)
    .then(json => {
      if (!json) return;
      const lang = (navigator.language || "en").slice(0,2);
      if (json.opponent_left && json.opponent_left[lang]) {
        i18n.opponent_left = json.opponent_left[lang];
      } else if (json.opponent_left?.en) {
        i18n.opponent_left = json.opponent_left.en;
      }
    }).catch(()=>{});

  // --- URL params ---
  const url = new URL(location.href);
  const room = clampInt(url.searchParams.get("room"), 1, 4, 1);
  const wantSeat = normalizeSeat(url.searchParams.get("seat"));
  $("#hud-room").textContent = String(room);

  // --- state ---
  let seat = "observer";
  let token = "";
  let es = null;
  let lastSnap = null;
  let uiStatusOverride = null; // 'leave' を一時固定
  let selfLeaving = false;     // 自分の Lobby 退室時のモーダル抑止

  // --- DOM refs ---
  const hudSeat = $("#hud-seat");
  const hudTurn = $("#hud-turn");
  const hudStatus = $("#hud-status");
  const hudWatchers = $("#hud-watchers");
  const boardEl = $("#board");
  const modal = $("#modal");
  const modalText = $("#modal-text");
  const modalOk = $("#modal-ok");

  // --- helpers ---
  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
  }
  function normalizeSeat(s) {
    s = (s || "").toLowerCase();
    return (s === "black" || s === "white") ? s : "observer";
  }
  function headersJSON() { return { "content-type": "application/json" }; }
  function setTokenFromResponse(res) {
    const t = res.headers.get("X-Play-Token");
    if (t) token = t;
  }
  function sseURL() {
    const sseId = randId();
    // DO 側にそのまま渡される（Pages の _middleware が /sse に転送）
    const u = new URL("/", location.origin);
    u.searchParams.set("room", String(room));
    u.searchParams.set("seat", seat);
    u.searchParams.set("sse", sseId);
    return { url: u.toString(), sseId };
  }
  function randId(){ return Math.random().toString(36).slice(2,10); }

  function applyHud(snap) {
    hudSeat.textContent = seat;
    const turnTxt = snap.turn === "black" ? "●"
                 : snap.turn === "white" ? "○"
                 : "–";
    hudTurn.textContent = turnTxt;
    const statusTxt = uiStatusOverride || snap.status || "-";
    hudStatus.textContent = statusTxt;
    hudWatchers.textContent = String(snap.watchers ?? 0);
  }

  function renderBoard(stones, legal) {
    boardEl.innerHTML = "";
    for (let y=0; y<8; y++) {
      for (let x=0; x<8; x++) {
        const idx = y*8+x;
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.pos = String.fromCharCode(97+x) + (y+1);

        const ch = stones[y][x];
        if (ch === "B" || ch === "W") {
          const s = document.createElement("div");
          s.className = "stone " + (ch === "B" ? "black" : "white");
          cell.appendChild(s);
        }
        if (Array.isArray(legal) && legal.includes(cell.dataset.pos)) {
          const mark = document.createElement("div");
          mark.className = "legal";
          cell.appendChild(mark);
        }

        cell.addEventListener("click", onCellClick);
        boardEl.appendChild(cell);
      }
    }
  }

  function zeroBoard() {
    boardEl.querySelectorAll(".stone,.legal").forEach(el => el.remove());
  }

  async function onCellClick(e) {
    const pos = e.currentTarget.dataset.pos;
    // 観戦 or 自手番でない or override中は不可
    if (seat === "observer") return;
    if (uiStatusOverride === "leave") return;
    if (!lastSnap || lastSnap.turn !== seat) return;
    const legal = lastSnap.legal || [];
    if (!legal.includes(pos)) return;

    const res = await fetch("/api/move", {
      method:"POST",
      headers: { ...headersJSON(), "X-Play-Token": token },
      body: JSON.stringify({ room, seat, pos })
    });
    const snap = await res.json();
    lastSnap = snap;
    applyHud(snap);
    renderBoard(snap.board.stones, snap.legal);
  }

  // --- modal control ---
  function showOpponentLeft() {
    modalText.textContent = i18n.opponent_left;
    modal.classList.add("show");
    uiStatusOverride = "leave";   // UIは leave で固定
    zeroBoard();                  // 盤面ゼロ
    applyHud(lastSnap || {});
  }
  function hideModalToWaiting() {
    modal.classList.remove("show");
    uiStatusOverride = null;      // 次の applyHud で waiting（サーバ通信なし）
    applyHud(lastSnap || {});
  }

  modalOk.addEventListener("click", hideModalToWaiting);

  // --- Lobby link ---
  $("#to-lobby").addEventListener("click", async (e) => {
    e.preventDefault();
    selfLeaving = true;
    if (es) { try{ es.close(); }catch{} es = null; }
    if (token && (seat === "black" || seat === "white")) {
      try {
        await fetch("/api/action", {
          method:"POST",
          headers: { ...headersJSON(), "X-Play-Token": token },
          body: JSON.stringify({ action:"leave", room, seat })
        });
      } catch {}
    }
    location.href = "/index.html";
  });

  // --- join & sse start ---
  async function join() {
    const res = await fetch("/api/action", {
      method:"POST",
      headers: headersJSON(),
      body: JSON.stringify({ action:"join", room, seat: wantSeat, sse: "will-replace" })
    });
    setTokenFromResponse(res);
    const snap = await res.json();
    // サーバ側に「席が埋まっているので観戦へ」の場合 seat を observer に矯正
    seat = (wantSeat === "black" || wantSeat === "white") ? wantSeat : "observer";
    if (snap.seat === "observer") seat = "observer";

    lastSnap = snap;
    applyHud(snap);
    renderBoard(snap.board.stones, snap.legal);

    const {url: sseUrl} = sseURL();
    es = new EventSource(sseUrl, { withCredentials:false });
    es.addEventListener("room_state", onRoomState);
    es.addEventListener("ping", () => {});
    es.onerror = () => { /* silent */ };
  }

  function opponentLeftTransition(prev, now) {
    // playing → waiting かつ 自分はプレイヤーで相手席が空いたと見做せるとき
    if (!prev || prev.status !== "playing") return false;
    if (!now || now.status !== "waiting") return false;
    if (!(seat === "black" || seat === "white")) return false;
    // seats occupancy があれば使う
    if (now.seats && typeof now.seats.black === "boolean" && typeof now.seats.white === "boolean") {
      const myOcc = seat === "black" ? now.seats.black : now.seats.white;
      const opOcc = seat === "black" ? now.seats.white : now.seats.black;
      if (myOcc && !opOcc) return true;
    }
    // 後方互換：board が初期盤面 ＋ turn が null（or –）なら対戦崩壊と推定
    try {
      const s = now.board?.stones || [];
      const center = [ s[3]?.slice(3,5), s[4]?.slice(3,5) ].join(",");
      const init = "WB,BW";
      const looksInit = center === init.replace(",", "");
      // turn が存在しない or null
      const noTurn = !now.turn;
      if (looksInit && noTurn) return true;
    } catch {}
    return false;
  }

  function onRoomState(ev) {
    const snap = JSON.parse(ev.data);

    // 自分の退室アクション後に届く古い SSE は無視
    if (selfLeaving) return;

    // 相手退出の瞬間を検出してモーダル
    if (opponentLeftTransition(lastSnap, snap)) {
      lastSnap = snap;
      showOpponentLeft();
      renderBoard(snap.board.stones, []); // ゼロ化済みだが安全側
      return;
    }

    lastSnap = snap;
    applyHud(snap);
    renderBoard(snap.board.stones, snap.legal);

    // 対戦再開（相手再入室）時は強制的にモーダルを閉じる
    if (uiStatusOverride === "leave" && snap.status === "playing") {
      hideModalToWaiting();
    }
  }

  // --- start ---
  (async () => {
    await join();
  })();
})();