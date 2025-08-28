// Reversi room client 0.9e (white theme, simple)
// Endpoints: POST /api/action, GET /sse?room=...
// - show legal moves only for side-to-move
// - opponent leave: show modal once; no extra network call

const qs = (s, r = document) => r.querySelector(s);
const hud = {
  room: qs('#hud-room'),
  seat: qs('#hud-seat'),
  turn: qs('#hud-turn'),
  status: qs('#hud-status'),
  watchers: qs('#hud-watchers'),
};
const toLobby = qs('#to-lobby');
const grid = qs('#grid');
const modal = qs('#modal-backdrop');
const modalText = qs('#modal-text');
const modalOk = qs('#modal-ok');

let state = {
  room: 1,
  seat: 'observer',      // 'black' | 'white' | 'observer'
  status: '-',           // 'waiting' | 'playing' | 'leave' | 'finished' | '-'
  turn: null,            // 'black' | 'white' | null
  board: Array(8).fill('--------'),
  legal: [],
  watchers: 0,
};

// ---- UI helpers ----
function initGrid() {
  grid.innerHTML = '';
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    grid.appendChild(cell);
  }
}
function xyToIndex(x, y){ return y*8 + x; }

function renderBoard() {
  const cells = grid.children;
  // stones & markers
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = xyToIndex(x, y);
      const cell = cells[idx];
      cell.innerHTML = '';
      const ch = state.board[y][x];
      if (ch === 'B' || ch === 'W') {
        const st = document.createElement('div');
        st.className = 'stone ' + (ch === 'B' ? 'black' : 'white');
        cell.appendChild(st);
      }
    }
  }
  // legal (only if it's my turn, and I'm black/white)
  if (state.turn === state.seat && (state.seat === 'black' || state.seat === 'white')) {
    for (const pos of state.legal) {
      const x = pos.charCodeAt(0) - 97; // 'a' -> 0
      const y = parseInt(pos.slice(1), 10) - 1;
      const dot = document.createElement('div');
      dot.className = 'legal';
      grid.children[xyToIndex(x,y)].appendChild(dot);
    }
  }
}

function updateHud() {
  hud.room.textContent = state.room;
  hud.seat.textContent = state.seat;
  hud.turn.textContent = state.turn ? state.turn : '–';
  hud.status.textContent = state.status || '–';
  hud.watchers.textContent = state.watchers ?? 0;
}

function showModal(msg){
  modalText.textContent = msg;
  modal.removeAttribute('hidden');
}
function hideModal(){ modal.setAttribute('hidden',''); }

// ---- Networking ----
const urlParams = new URLSearchParams(location.search);
state.room = Math.min(4, Math.max(1, parseInt(urlParams.get('room')||'1',10)));

toLobby.addEventListener('click', ()=> location.href = '/');

modalOk.addEventListener('click', hideModal);

async function postAction(body){
  const res = await fetch('/api/action', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // pick seat from first join response (observer if occupied)
  if (body.action === 'join') {
    state.seat = data.seat || state.seat;
  }
  applySnapshot(data);
}

function applySnapshot(snap){
  const prev = { ...state };
  // normalize
  state.status = snap.status ?? state.status;
  state.turn = snap.turn ?? state.turn;
  state.board = (snap.board && snap.board.stones) ? snap.board.stones.slice() : state.board;
  state.legal = Array.isArray(snap.legal) ? snap.legal.slice() : [];
  state.watchers = snap.watchers ?? state.watchers;

  // opponent-left detection:
  // 以前: playing → 今: waiting かつ 自席が black/white のまま（トークン生存）
  if (prev.status === 'playing' && state.status === 'waiting' &&
      (state.seat === 'black' || state.seat === 'white')) {
    showModal('対戦相手が退出しました。');
  }

  updateHud();
  renderBoard();
}

// join as seat by query ?seat=black/white/observer (default: observer → 自動で座らない)
const wantSeat = urlParams.get('seat') || 'observer';
postAction({ action:'join', room: state.room, seat: wantSeat }).catch(console.error);

// SSE
(function openSSE(){
  const seatParam = (state.seat || 'observer');
  const es = new EventSource(`/sse?room=${state.room}&seat=${seatParam}`);
  es.addEventListener('room_state', (ev)=>{
    try{ applySnapshot(JSON.parse(ev.data)); }catch(_){}
  });
  es.onerror = ()=>{ /* let CF auto-retry */ };
})();
 
// click to move (only my turn)
grid.addEventListener('click', async (ev)=>{
  if (state.turn !== state.seat) return;
  const cell = ev.target.closest('.cell');
  if (!cell) return;
  const idx = Array.prototype.indexOf.call(grid.children, cell);
  const x = idx % 8, y = Math.floor(idx/8);
  const pos = String.fromCharCode(97 + x) + (y + 1);
  if (!state.legal.includes(pos)) return;

  const res = await fetch('/api/move', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ room: state.room, pos }),
  });
  const data = await res.json();
  applySnapshot(data);
});

// prepare board
initGrid();