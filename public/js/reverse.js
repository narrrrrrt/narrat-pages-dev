// public/js/reverse.js -- v1.1.3
// 目的: v1.1 仕様に合わせて UI を更新。特に「相手が退出したら」即ポップアップ→盤面クリア→退室/ロビーへ。
// 既存の HB(7s) / Beacon leave(sendBeacon) / move POST は挙動据え置き（デグレ防止）。

(function () {
  // ---- ユーティリティ ----
  function qs(k) {
    const u = new URL(location.href);
    return u.searchParams.get(k);
  }
  function randId() {
    return Math.random().toString(16).slice(2, 10);
  }
  function $(sel) { return document.querySelector(sel); }

  // i18n: 既存の system_messages.json を使う（無ければデフォルト文言）
  let MSG = { opponent_left: '対戦相手が退出しました' };
  fetch('/i18n/system_messages.json').then(r => r.json()).then(all => {
    // Accept-Language はブラウザが付ける。ここでは ja 優先で落とすだけ。
    const lang = (navigator.language || 'en').slice(0,2);
    if (all && all.opponent_left && all.opponent_left[lang]) {
      MSG.opponent_left = all.opponent_left[lang] || MSG.opponent_left;
    } else if (all && all.opponent_left && all.opponent_left.en) {
      MSG.opponent_left = all.opponent_left.en;
    }
  }).catch(()=>{ /* optional */ });

  // ---- パラメータ ----
  const room = Math.max(1, Math.min(4, parseInt(qs('room') || '1', 10)));
  const wantSeat = (qs('seat') || 'observer'); // black | white | observer
  const sseId = randId();

  // ---- 状態 ----
  let token = '';           // X-Play-Token
  let mySeat = 'observer';  // サーバ snapshot に合わせて更新
  let lastStatus = null;    // playing → leave の遷移検知用
  let hbTimer = null;

  // ---- UI 要素（既存のDOMに合わせて最低限）----
  const elTurn = $('#turn') || createIndicator();
  const elBoard = $('#board') || createBoard();
  const elLeaveBtn = $('#btn-leave');
  function createIndicator() {
    const el = document.createElement('div');
    el.id = 'turn';
    el.style.margin = '8px 0';
    document.body.prepend(el);
    return el;
  }
  function createBoard() {
    const table = document.createElement('table');
    table.id = 'board';
    table.style.borderCollapse = 'collapse';
    table.style.margin = '8px 0';
    const tbody = document.createElement('tbody');
    for (let y=0; y<8; y++) {
      const tr = document.createElement('tr');
      for (let x=0; x<8; x++) {
        const td = document.createElement('td');
        td.dataset.xy = String.fromCharCode(97 + x) + (y + 1);
        td.style.width = '32px'; td.style.height = '32px'; td.style.textAlign = 'center';
        td.style.border = '1px solid #ccc';
        td.style.fontSize = '20px';
        td.addEventListener('click', onCellClick);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    document.body.appendChild(table);
    return table;
  }

  // ---- 初期 JOIN ----
  async function join() {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'join', room, seat: wantSeat, sse: sseId })
    });
    if (!res.ok) {
      alert('Join failed: ' + res.status);
      location.href = '/index.html';
      return;
    }
    token = res.headers.get('X-Play-Token') || '';
    const snap = await res.json().catch(()=>null);
    if (snap && snap.seat) mySeat = snap.seat; // サーバ決定（席が埋まっていたら observer ）
    // SSE 開始
    startSse();
    // ブラウザ参加者のみ HB
    if (token) startHeartbeat();
  }

  // ---- SSE ----
  let es = null;
  function startSse() {
    if (es) { es.close(); es = null; }
    const url = `/?room=${room}&seat=${encodeURIComponent(mySeat)}&sse=${encodeURIComponent(sseId)}`;
    es = new EventSource(url);
    es.addEventListener('room_state', (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        if (snap.seat) mySeat = snap.seat; // 恒常的に同期
        applySnapshot(snap);
        detectLeaveTransition(snap);
      } catch (e) {
        console.warn('parse room_state failed', e);
      }
    });
    es.onerror = () => {
      console.warn('room sse error');
      // ブラウザの自動再接続に任せる
    };
  }

  // ---- Heartbeat（7s）----
  function startHeartbeat() {
    if (hbTimer) return;
    const send = () => {
      // 204 No Content, 応答は読まない（投げっぱなし）
      fetch('/api/action', { method: 'POST', keepalive: true, headers: { 'X-Play-Token': token } }).catch(()=>{});
    };
    send(); // すぐ1発
    hbTimer = setInterval(send, 7000);
    // Back/遷移で早期退室（Beacon：ヘッダ不可 → sseId を使用）
    const beacon = () => {
      try {
        navigator.sendBeacon('/api/action', JSON.stringify({ action: 'leave', room, sse: sseId }));
      } catch {}
    };
    window.addEventListener('pagehide', beacon);
    window.addEventListener('beforeunload', beacon);
  }

  // ---- 盤面・着手 ----
  function onCellClick(e) {
    const td = e.currentTarget;
    if (!td || !token) return; // 観戦・未参加は打てない
    const pos = td.dataset.xy;
    fetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Play-Token': token },
      body: JSON.stringify({ room, pos })
    }).catch(()=>{});
    // 応答は読む必要なし。UI更新は SSE で入る。
  }

  function renderBoard(board, legal) {
    if (!board || !Array.isArray(board.stones)) return;
    const map = {}; (legal||[]).forEach(p => map[p] = true);
    const tds = elBoard.querySelectorAll('td[data-xy]');
    tds.forEach(td => {
      const xy = td.dataset.xy;
      const x = td.dataset.xy.charCodeAt(0) - 97;
      const y = parseInt(td.dataset.xy.slice(1), 10) - 1;
      const v = board.stones[y][x];
      td.textContent = (v === 'B') ? '●' : (v === 'W' ? '○' : (map[xy] ? '·' : ''));
      td.style.opacity = map[xy] ? '0.5' : '1';
    });
  }

  function setTurn(turn) {
    if (!turn) { elTurn.textContent = 'Turn: –'; return; }
    elTurn.textContent = 'Turn: ' + (turn === 'black' ? '●' : '○');
  }

  function clearBoardToEmpty() {
    const tds = elBoard.querySelectorAll('td[data-xy]');
    tds.forEach(td => { td.textContent = ''; td.style.opacity = '1'; });
    setTurn(null);
  }

  function applySnapshot(snap) {
    renderBoard(snap.board, snap.legal);
    setTurn(snap.turn);
    lastStatus = snap.status;
  }

  // ---- 退出検知（playing→leave、観戦は除外）----
  function detectLeaveTransition(snap) {
    if (lastStatus === 'playing' && snap.status === 'leave' && mySeat !== 'observer') {
      // 仕様：ポップアップ → 盤面ゼロ → leave → ロビーへ
      alert(MSG.opponent_left);
      clearBoardToEmpty();
      // 自席も退室（204, 本文なし）
      if (token) {
        fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Play-Token': token },
          body: JSON.stringify({ action: 'leave', room })
        }).catch(()=>{});
      }
      // ロビーへ戻る
      location.href = '/index.html';
    }
  }

  // ---- 任意：退室ボタン（あれば）----
  if (elLeaveBtn) {
    elLeaveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (token) {
        fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Play-Token': token },
          body: JSON.stringify({ action: 'leave', room })
        }).finally(()=> location.href = '/index.html');
      } else {
        location.href = '/index.html';
      }
    });
  }

  // ---- 起動 ----
  join();
})();