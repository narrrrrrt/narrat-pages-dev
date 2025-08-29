// public/js/reverse.js -- v1.1.4 (debug: log response header/body)

(function () {
  // ---- tiny utils ---------------------------------------------------------
  function qs(k) { const u = new URL(location.href); return u.searchParams.get(k); }
  function $(s) { return document.querySelector(s); }
  function randId() { return Math.random().toString(16).slice(2, 10); }
  function enc(s) { return encodeURIComponent(s); }

  // ---- i18n (最小) --------------------------------------------------------
  let MSG = { opponent_left: 'Opponent left' };
  fetch('/i18n/system_messages.json').then(r => r.json()).then(all => {
    const lang = (navigator.language || 'en').slice(0, 2);
    if (all && all.opponent_left) MSG.opponent_left = all[lang]?.opponent_left || all.en || MSG.opponent_left;
  }).catch(() => {});

  // ---- room / seats -------------------------------------------------------
  const room = Math.min(4, Math.max(1, parseInt(qs('room') || '1', 10)));
  const wantSeat = (qs('seat') || 'observer'); // 'black'|'white'|'observer'
  const sseId = randId();

  // state
  let token = '';
  let mySeat = 'observer';
  let lastStatus = null;
  let hbTimer = null;

  // HUD
  $('#room-no').textContent = String(room);

  // ---- board rendering ----------------------------------------------------
  const elBoard  = $('#board');
  const elGrid   = $('#grid');
  const elStones = $('#stones');
  const elLegals = $('#legals');

  function createGrid() {
    const frag = document.createDocumentFragment();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const c = document.createElement('div');
        c.className = 'cell';
        c.dataset.xy = String.fromCharCode(97 + x) + (y + 1); // a1..h8
        frag.appendChild(c);
      }
    }
    elGrid.innerHTML = '';
    elGrid.appendChild(frag);
  }

  function renderBoard(board, legal) {
    if (!board || !Array.isArray(board.stones)) return;
    const map = {};
    (legal || []).forEach(p => (map[p] = true));

    // stones
    const stones = board.stones;
    elStones.innerHTML = '';
    const sf = document.createDocumentFragment();
    for (let y = 0; y < 8; y++) {
      const row = stones[y] || '--------';
      for (let x = 0; x < 8; x++) {
        const ch = row[x];
        if (ch === 'W' || ch === 'B') {
          const d = document.createElement('div');
          d.className = 'stone ' + (ch === 'W' ? 'W' : 'B');
          d.style.setProperty('--x', x);
          d.style.setProperty('--y', y);
          sf.appendChild(d);
        }
      }
    }
    elStones.appendChild(sf);

    // legal
    elLegals.innerHTML = '';
    const lf = document.createDocumentFragment();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const xy = String.fromCharCode(97 + x) + (y + 1);
        if (map[xy]) {
          const h = document.createElement('div');
          h.className = 'legal';
          h.style.setProperty('--x', x);
          h.style.setProperty('--y', y);
          h.dataset.xy = xy;
          lf.appendChild(h);
        }
      }
    }
    elLegals.appendChild(lf);
  }

  // ---- debug print --------------------------------------------------------
  const dbgEl = $('#debug-join');
  function dbg(title, obj) {
    if (!dbgEl) return;
    const ts = new Date().toLocaleTimeString();
    const head = title ? `[${ts}] ${title}\n` : '';
    const body = obj !== undefined ? (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) : '';
    dbgEl.textContent = (head + body + '\n\n' + dbgEl.textContent).slice(0, 12000);
  }

  // ---- join / heartbeat / sse --------------------------------------------
  async function join() {
    const body = { action: 'join', room, seat: wantSeat, sse: sseId };
    dbg('JOIN body', body);

    let res;
    try {
      res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      dbg('JOIN fetch error', String(e));
      return;
    }

    // header
    const tk = res.headers.get('X-Play-Token') || '';
    if (tk) token = tk;
    dbg('JOIN response header', { status: res.status, token });

    // body(raw -> json)
    let raw = '';
    try { raw = await res.text(); } catch (e) {}
    dbg('JOIN response raw(<=512B)', raw.slice(0, 512));

    let snap = null;
    try { snap = raw ? JSON.parse(raw) : null; } catch (e) {
      dbg('JOIN JSON parse error', String(e));
    }

    if (snap && snap.seat) mySeat = snap.seat;
    applySnapshot(snap);

    // SSE & HB
    startSse();
    startHeartbeat();
    window.addEventListener('pagehide', beaconLeave);
  }

  function startHeartbeat() {
    if (!token) return;
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      fetch('/api/action', { method: 'POST', headers: { 'X-Play-Token': token } }).catch(() => {});
    }, 7000);
  }

  function beaconLeave() {
    try {
      navigator.sendBeacon('/api/action', JSON.stringify({ action: 'leave', room, sse: sseId }));
    } catch {}
  }

  function startSse() {
    const url = `/?room=${room}&seat=${enc(mySeat || 'observer')}&sse=${enc(sseId)}`;
    const es = new EventSource(url);
    es.addEventListener('room_state', ev => {
      dbg('SSE event room_state (len)', String(ev.data?.length ?? 0));
      try {
        const snap = JSON.parse(ev.data);
        applySnapshot(snap);
      } catch (e) {
        dbg('SSE parse error', String(e));
      }
    });
    es.onerror = () => { /* silent */ };
  }

  // ---- snapshot -> UI -----------------------------------------------------
  function applySnapshot(snap) {
    if (!snap) return;
    $('#seat-now').textContent = snap.seat || mySeat || '-';
    $('#status').textContent = snap.status || '-';
    $('#turn').textContent = snap.turn === 'black' ? '●'
                       : snap.turn === 'white' ? '○' : '–';
    $('#watchers').textContent = String(snap.watchers ?? 0);
    if (snap.board) renderBoard(snap.board, snap.legal || []);
  }

  // ---- init ---------------------------------------------------------------
  createGrid();
  join().catch(err => dbg('JOIN error', String(err)));
})();