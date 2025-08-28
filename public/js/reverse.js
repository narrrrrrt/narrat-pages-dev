// Reversi room client (0.9b)
// - legal moves: show only when seat==turn && status=='playing'
// - leave latch: playing -> leave を一度だけ検出してモーダル表示、OKまでUIはleave固定
// - hoshi: 4点のみ配置（(2,2), (5,2), (2,5), (5,5) の交点相当）
// 依存: DOM に .grid, .board, .badge などが存在すること（reverse.html 0.9a 相当）

(() => {
  const qs = new URLSearchParams(location.search);
  const room = Math.max(1, Math.min(4, parseInt(qs.get('room') || '1', 10)));
  const seat = (qs.get('seat') || 'observer'); // 'black' | 'white' | 'observer'

  // UI refs
  const elTurn = document.querySelector('[data-indicator="turn"]');
  const elStatus = document.querySelector('[data-indicator="status"]');
  const elWatch = document.querySelector('[data-indicator="watchers"]');
  const grid = document.querySelector('.grid');
  const boardWrap = document.querySelector('.board');
  const debugEl = document.getElementById('debug');

  // Modal (simple)
  const modalBack = document.createElement('div');
  modalBack.className = 'modal-backdrop';
  modalBack.innerHTML = `
    <div class="modal">
      <p class="msg"></p>
      <div class="row"><button class="btn">OK</button></div>
    </div>`;
  document.body.appendChild(modalBack);
  const modalMsg = modalBack.querySelector('.msg');
  modalBack.querySelector('.btn').addEventListener('click', () => {
    hideModal();
    // ラッチ解除：OK 押下でwaitingへ追従を再開
    leaveLatch = false;
    // 直近のスナップショットを再描画
    if (lastSnap) render(lastSnap);
  });
  function showModal(text) {
    modalMsg.textContent = text || ' ';
    modalBack.style.display = 'flex';
  }
  function hideModal() {
    modalBack.style.display = 'none';
  }

  // Hoshi (4 points) -- placed once
  placeHoshiDots();
  function placeHoshiDots() {
    const sz = getCellSize();
    // 交点座標: (2,2), (5,2), (2,5), (5,5)
    const points = [
      [2,2],[5,2],[2,5],[5,5]
    ];
    for (const [cx, cy] of points) {
      const dot = document.createElement('div');
      dot.className = 'hoshi';
      const leftPct = ((cx + 0.5) / 8) * 100;
      const topPct  = ((cy + 0.5) / 8) * 100;
      dot.style.left = `${leftPct}%`;
      dot.style.top = `${topPct}%`;
      boardWrap.appendChild(dot);
    }
    // 念のためリサイズで位置微調不要（%指定のため追従）
    window.addEventListener('resize', () => {});
    function getCellSize() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 42; }
  }

  // State
  let sse;
  let token = '';           // X-Play-Token （黒白のみ）
  let prevStatus = null;    // 前回の status
  let leaveLatch = false;   // モーダルOKまでUIをleave固定
  let lastSnap = null;      // 直近 snapshot

  // i18n（最低限）
  const i18n = { opponent_left: '対戦相手が退出しました。' };
  // もし reverse.html で window.I18N が用意されていればそれを使う
  if (window.I18N && typeof window.I18N === 'object') {
    Object.assign(i18n, window.I18N);
  }

  // ---- JOIN ----
  join();

  async function join() {
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join', room, seat, sse: genSseId() })
      });
      if (res.ok) {
        token = res.headers.get('X-Play-Token') || '';
        const snap = await res.json();
        render(snap);
        openSSE();
      }
    } catch (e) {
      log('join error', e);
    }
  }

  function openSSE() {
    const url = `/sse?room=${room}&seat=${encodeURIComponent(seat)}`;
    sse = new EventSource(url, { withCredentials: false });
    sse.addEventListener('room_state', (ev) => {
      const snap = JSON.parse(ev.data);
      lastSnap = snap;
      render(snap);
    });
    sse.addEventListener('ping', () => { /* HB */ });
    sse.onerror = () => { /* noop; server controls close */ };
  }

  // ---- RENDER ----
  function render(snap) {
    // ラッチ時は status を強制的に leave 表示
    const statusForUI = leaveLatch ? 'leave' : snap.status;

    setIndicators({
      turn: snap.turn,
      status: statusForUI,
      watchers: snap.watchers
    });

    // 盤面描画
    drawBoard(snap.board.stones);

    // 合法手：自席・自分の手番・playing のときのみ
    clearLegals();
    if (!leaveLatch &&
        seat !== 'observer' &&
        snap.status === 'playing' &&
        snap.turn === seat &&
        Array.isArray(snap.legal)) {
      drawLegals(snap.legal);
    }

    // 退出検出（playing -> leave への立ち上がりで一度だけ）
    if (!leaveLatch && prevStatus === 'playing' && snap.status === 'leave') {
      // 相手が退出したケースだけ通知（自分 leave では出さない）
      // サーバは双方の status を 'leave' にするため、手番や token には依存しないでそのまま通知でOK
      leaveLatch = true;
      clearLegals();
      // 盤面はゼロ化（UIのみ）
      drawBoard(blankBoard());
      showModal(i18n.opponent_left || 'Opponent left the room.');
    }
    prevStatus = snap.status;
  }

  function setIndicators({ turn, status, watchers }) {
    elTurn.innerHTML = turn === 'black' ? '<span class="dot" style="background:#000"></span>'
                    : turn === 'white' ? '<span class="dot" style="background:#fff"></span>'
                    : '–';
    elStatus.textContent = status;
    elWatch.textContent = String(watchers || 0);
  }

  function drawBoard(stones) {
    // stones: 8行の文字列配列
    grid.innerHTML = '';
    for (let y = 0; y < 8; y++) {
      const row = stones[y];
      for (let x = 0; x < 8; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        const ch = row[x];
        if (ch === 'B' || ch === 'W') {
          const s = document.createElement('div');
          s.className = 'stone ' + (ch === 'B' ? 'black' : 'white');
          cell.appendChild(s);
        }
        grid.appendChild(cell);
      }
    }
  }

  function clearLegals() {
    grid.querySelectorAll('.legal').forEach(el => el.remove());
  }

  function drawLegals(list) {
    for (const pos of list) {
      const [x, y] = posToXY(pos); // 0-index
      const idx = y * 8 + x;
      const cell = grid.children[idx];
      if (!cell) continue;
      const dot = document.createElement('div');
      dot.className = 'legal';
      cell.appendChild(dot);
      // クリックで打つ
      cell.addEventListener('click', () => tryMove(pos), { once: true });
    }
  }

  async function tryMove(pos) {
    if (!token) return;
    try {
      const res = await fetch('/api/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Play-Token': token
        },
        body: JSON.stringify({ room, seat, pos })
      });
      const snap = await res.json();
      lastSnap = snap;
      render(snap);
    } catch (e) {
      log('move error', e);
    }
  }

  // ---- Utils ----
  function blankBoard() {
    return Array.from({ length: 8 }, () => '--------');
  }
  function posToXY(pos) {
    // "d3" -> [3,2]
    const x = pos.charCodeAt(0) - 97;
    const y = parseInt(pos.slice(1), 10) - 1;
    return [x, y];
  }
  function genSseId() {
    return Math.random().toString(36).slice(2, 10);
  }
  function log(...a) {
    if (!debugEl) return;
    const ts = new Date().toLocaleTimeString();
    debugEl.textContent = `[${ts}] ${a.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}\n` + debugEl.textContent;
  }

  // ---- Leave button ----
  // reverse.html 側で <a data-link="lobby"> がある想定（リンク自体はそのまま）
  const leaveLink = document.querySelector('[data-link="lobby"]');
  if (leaveLink) {
    leaveLink.addEventListener('click', async (e) => {
      // サーバへ leave（トークン削除）
      try {
        await fetch('/api/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'X-Play-Token': token } : {})
          },
          body: JSON.stringify({ action: 'leave', room })
        });
      } catch {}
      // 以降は通常の遷移（ロビーへ）
    });
  }

  // ページ離脱時のクリーンアップ
  window.addEventListener('beforeunload', () => {
    if (sse) try { sse.close(); } catch {}
  });
})();