// Reversi room client 1.1 (Step1: Browser Heartbeat + Beacon Leave)
// ベース: v0.9h（元実装）にHB/Beaconを追加。既存の描画・SSE・join/leaveは維持。

(() => {
  const q = (s) => document.querySelector(s);
  const hud = {
    room: q('#hud-room'), seat: q('#hud-seat'),
    turn: q('#hud-turn'), status: q('#hud-status'),
    watchers: q('#hud-watchers')
  };
  const gridEl = q('#grid');
  const stonesEl = q('#stones');
  const legalsEl = q('#legals');
  const lobbyLink = q('#to-lobby');

  const url = new URL(location.href);
  const room = Number(url.searchParams.get('room') || '1');
  const wantSeat = (url.searchParams.get('seat') || 'observer');
  let seat = 'observer';
  let status = 'waiting';
  let turn = null;
  let token = localStorage.getItem('playToken') || '';
  let sse; let sseId = Math.random().toString(36).slice(2);

  let leaveLatch = false; // ポップアップ中 leave 固定

  // --- Heartbeat (Browser only) ---
  const HB_INTERVAL_MS = 7000; // 7s
  let hbTimer = null;

  function startHeartbeat(){
    stopHeartbeat();
    if (!token) return; // 観戦者などトークン未取得時は送らない
    hbTimer = setInterval(() => {
      // /api/action にヘッダだけで空POST（204想定）。レスは使わない。
      fetch('/api/action', {
        method: 'POST',
        keepalive: true,
        headers: { 'X-Play-Token': token }
        // body なし
      }).catch(()=>{ /* ネット切断などは無視 */ });
    }, HB_INTERVAL_MS);
  }
  function stopHeartbeat(){
    if (hbTimer){ clearInterval(hbTimer); hbTimer = null; }
  }

  // --- pagehide/beforeunload: 早期退室（Beacon） ---
  function sendLeaveBeacon(){
    try {
      const body = JSON.stringify({ action: 'leave', room, sse: sseId });
      // Beacon はヘッダ付与不可。サーバ側は sseId で退室を受理する。
      navigator.sendBeacon('/api/action', body);
    } catch {}
  }
  addEventListener('pagehide', sendLeaveBeacon, { capture: true });
  addEventListener('beforeunload', sendLeaveBeacon, { capture: true });

  // --- UI helpers ---
  const xyOfIndex = (idx) => [idx % 8, Math.floor(idx / 8)];
  const posCenter = (x, y) => {
    const cs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size'));
    const gp = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-gap'));
    const xpx = x * (cs + gp) + cs / 2;
    const ypx = y * (cs + gp) + cs / 2;
    return [xpx, ypx];
  };

  function setHUD(snap) {
    hud.room.textContent = String(snap.room || room);
    hud.seat.textContent = seat;
    hud.turn.textContent = snap.turn ?? '–';
    hud.status.textContent = snap.status;
    hud.watchers.textContent = String(snap.watchers ?? 0);
  }

  function buildGrid() {
    gridEl.innerHTML = '';
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'cell';
      gridEl.appendChild(d);
    }
  }

  function drawStones(board) {
    stonesEl.innerHTML = '';
    board.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === 'B' || ch === 'W') {
          const el = document.createElement('div');
          el.className = 'stone ' + (ch === 'B' ? 'black' : 'white');
          const [cx, cy] = posCenter(x, y);
          el.style.left = cx + 'px';
          el.style.top = cy + 'px';
          stonesEl.appendChild(el);
        }
      });
    });
  }

  function drawLegals(legal) {
    legalsEl.innerHTML = '';
    if (!turn || seat !== turn) return;
    for (const p of legal || []) {
      const x = p.charCodeAt(0) - 97;
      const y = parseInt(p.slice(1), 10) - 1;
      const dot = document.createElement('div');
      dot.className = 'legal';
      const [cx, cy] = posCenter(x, y);
      dot.style.left = cx + 'px';
      dot.style.top = cy + 'px';
      legalsEl.appendChild(dot);
    }
  }

  stonesEl.parentElement.addEventListener('click', async (ev) => {
    if (!turn || seat !== turn) return;
    const rect = stonesEl.getBoundingClientRect();
    const cs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size'));
    const gp = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-gap'));
    const xrel = ev.clientX - rect.left;
    const yrel = ev.clientY - rect.top;
    const x = Math.floor(xrel / (cs + gp));
    const y = Math.floor(yrel / (cs + gp));
    const pos = String.fromCharCode(97 + x) + (y + 1);

    if (!token) return;
    await fetch('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Play-Token': token },
      body: JSON.stringify({ room, pos })
    }).catch(()=>{});
  });

  function openSSE() {
    if (sse) sse.close();
    const u = new URL('/sse', location.origin);
    u.searchParams.set('room', String(room));
    u.searchParams.set('seat', seat);
    u.searchParams.set('sse', sseId);
    sse = new EventSource(u);

    sse.addEventListener('room_state', (e) => {
      const snap = JSON.parse(e.data);
      if (leaveLatch) {
        snap.status = 'leave'; // モーダル中は強制 leave 表示
      }
      status = snap.status;
      turn = snap.turn;
      setHUD(snap);
      drawStones(snap.board.stones);
      drawLegals(snap.legal);

      // opponent-left detection
      if (!leaveLatch && snap.status === 'leave' && seat !== 'observer') {
        showModal('対戦相手が退出しました。');
      }
    });
  }

  async function join() {
    const body = { action: 'join', room, seat: wantSeat, sse: sseId };
    const res = await fetch('/api/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const snap = await res.json();
    const t = res.headers.get('X-Play-Token');
    if (t) { token = t; localStorage.setItem('playToken', token); }
    seat = snap.seat || 'observer';
    status = snap.status; turn = snap.turn;

    setHUD(snap);
    buildGrid();
    drawStones(snap.board.stones);
    drawLegals(snap.legal);

    openSSE();

    // ★ HBは join 成功後に開始（トークン取得済みのときのみ）
    startHeartbeat();
  }

  const modal = q('#modal-backdrop');
  const modalMsg = q('#modal-msg');
  q('#modal-ok').onclick = () => {
    hideModal();
    leaveLatch = false;
    status = 'waiting'; // 強制 waiting に戻す
    setHUD({room, status, turn, watchers:0});
  };
  function showModal(text){ modalMsg.textContent = text; modal.style.display = 'flex'; leaveLatch = true; }
  function hideModal(){ modal.style.display = 'none'; }

  lobbyLink.onclick = async () => {
    if (sse) { sse.close(); sse = null; }
    stopHeartbeat(); // ロビーへ戻る前にHB停止
    await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Play-Token': token },
      body: JSON.stringify({ action: 'leave', room, sse: sseId })
    }).catch(()=>{});
    location.href = '/';
  };

  (async () => { await join(); })();
})();