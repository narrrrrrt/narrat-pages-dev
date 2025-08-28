// Reversi room client 0.9g
(() => {
  // ---- DOM refs ----
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

  // ---- state ----
  const url = new URL(location.href);
  const room = Number(url.searchParams.get('room') || '1');
  const wantSeat = (url.searchParams.get('seat') || 'observer');
  let seat = 'observer';
  let status = 'waiting';
  let turn = null;     // 'black' | 'white' | null
  let token = localStorage.getItem('playToken') || '';
  let sse;             // EventSource
  let sseId = Math.random().toString(36).slice(2);

  // ---- helpers ----
  const xyOfIndex = (idx) => [idx % 8, Math.floor(idx / 8)];
  const posCenter = (x, y) => {
    // convert [0..7] to px center inside #stones / #legals area
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

  // ---- draw board grid once ----
  function buildGrid() {
    gridEl.innerHTML = '';
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'cell';
      gridEl.appendChild(d);
    }
  }

  // ---- draw stones ----
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

  // ---- draw legal marks (only when my turn) ----
  function drawLegals(legal) {
    legalsEl.innerHTML = '';
    if (!turn || seat !== turn) return;       // ← 自分の手番だけ表示
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

  // ---- board click → move (only when my turn & legal) ----
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

    // 送信
    if (!token) return;
    await fetch('/api/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Play-Token': token },
      body: JSON.stringify({ room, pos })
    }).catch(()=>{});
    // ハイライトはサーバーからの新スナップショット到着で更新/消去
  });

  // ---- SSE ----
  function openSSE() {
    if (sse) sse.close();
    const u = new URL('/sse', location.origin);
    u.searchParams.set('room', String(room));
    u.searchParams.set('seat', seat);
    u.searchParams.set('sse', sseId);
    sse = new EventSource(u, { withCredentials: false });

    sse.addEventListener('room_state', (e) => {
      const snap = JSON.parse(e.data);
      status = snap.status;
      turn = snap.turn;
      setHUD(snap);
      drawStones(snap.board.stones);
      drawLegals(snap.legal);
      // 退出検知 → ポップアップ（leave→waitingの流れはサーバーからの状態で反映）
      if (snap.status === 'leave' && seat !== 'observer') {
        showModal(msg('opponent_left'));
      }
    });
    sse.onerror = () => { /* keep-alive handled server-side */ };
  }

  // ---- join → then open SSE (avoid counting as watcher) ----
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

    openSSE();  // ← join 成功後に seat 付きで接続
  }

  // ---- modal ----
  const modal = q('#modal-backdrop');
  const modalMsg = q('#modal-msg');
  q('#modal-ok').onclick = () => hideModal();
  function showModal(text){ modalMsg.textContent = text; modal.style.display = 'flex'; }
  function hideModal(){ modal.style.display = 'none'; }
  function msg(key){
    // 簡易 i18n（既存の system_messages.json を使うならここで差し替え）
    if (key === 'opponent_left') return '対戦相手が退出しました。';
    return '';
  }

  // ---- leave ----
  lobbyLink.onclick = async () => {
    if (sse) { sse.close(); sse = null; }               // 先に SSE を閉じる
    await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Play-Token': token },
      body: JSON.stringify({ action: 'leave', room, sse: sseId })
    }).catch(()=>{});
    location.href = '/';
  };

  // ---- start ----
  (async () => { await join(); })();
})();