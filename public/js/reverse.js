// Reversi room client 1.1.1
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

  // --- Heartbeat (browser) ---
  let hbTimer = null;
  const HB_INTERVAL = 7000; // 7s

  function startHeartbeat() {
    if (!token) return;
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      try {
        fetch('/api/action', {
          method: 'POST',
          keepalive: true,
          headers: { 'X-Play-Token': token }
        }); // 204 expected
      } catch(_){/* noop */}
    }, HB_INTERVAL);
  }

  let leaveLatch = false; // ポップアップ中 leave 固定

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
    hud.status.textContent = snap.status || status || '-';
    hud.turn.textContent = (snap.turn==='black' ? '●' : snap.turn==='white' ? '○' : '–');
    hud.watchers.textContent = String(snap.watchers ?? 0);
  }

  function drawGrid() {
    const frag = document.createDocumentFragment();
    for (let i=0;i<64;i++){
      const cell = document.createElement('div');
      cell.className = 'cell';
      frag.appendChild(cell);
    }
    gridEl.innerHTML = '';
    gridEl.appendChild(frag);
  }

  function drawStones(stones){
    stonesEl.innerHTML = '';
    stones.forEach((row, y) => {
      row.split('').forEach((ch, x) => {
        if (ch==='W' || ch==='B'){
          const dot = document.createElement('div');
          dot.className = 'stone ' + (ch==='W' ? 'white' : 'black');
          const [cx, cy] = posCenter(x,y);
          dot.style.left = `${cx}px`;
          dot.style.top  = `${cy}px`;
          stonesEl.appendChild(dot);
        }
      });
    });
  }

  function drawLegals(legal){
    legalsEl.innerHTML = '';
    (legal||[]).forEach(p => {
      const x = p.charCodeAt(0) - 97; // a..h
      const y = parseInt(p.slice(1),10) - 1; // 1..8
      const dot = document.createElement('div');
      dot.className = 'legal';
      const [cx, cy] = posCenter(x,y);
      dot.style.left = `${cx}px`;
      dot.style.top  = `${cy}px`;
      legalsEl.appendChild(dot);
    });
  }

  function sseHeaders() {
    return { headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' } };
  }

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
      if (snap.status==='leave' && seat !== 'observer') {
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
    if (t) startHeartbeat();
    seat = snap.seat || 'observer';
    status = snap.status || status;
    turn = snap.turn ?? turn;

    drawGrid();
    setHUD(snap);
    drawStones(snap.board.stones);
    drawLegals(snap.legal);

    openSSE();
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
    await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Play-Token': token },
      body: JSON.stringify({ action: 'leave', room, sse: sseId })
    }).catch(()=>{});
    location.href = '/';
  };

  // Early leave via Beacon on navigation/back
  const leaveBeacon = () => {
    try {
      const payload = JSON.stringify({ action: 'leave', room, sse: sseId });
      navigator.sendBeacon('/api/action', payload);
    } catch(_){/* noop */}
  };
  window.addEventListener('pagehide', leaveBeacon);
  window.addEventListener('beforeunload', leaveBeacon);

  (async () => { await join(); })();
})();