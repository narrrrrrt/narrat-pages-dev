(function() {
  const SUP_LANGS = ['en','de','it','fr','es','ja'];
  const navLang = (navigator.language || 'en').toLowerCase();
  const lang = SUP_LANGS.find(l => navLang.startsWith(l)) || 'en';

  const params = new URLSearchParams(location.search);
  const room = Number(params.get('room') || '1');
  const side = params.get('side') || 'observer';
  const session = params.get('session') || genSession();

  const boardEl = document.getElementById('board');
  const colSel = document.getElementById('col');
  const rowSel = document.getElementById('row');
  const submitBtn = document.getElementById('submit');
  const infoEl = document.getElementById('info');
  const turnEl = document.getElementById('turn');
  const youEl = document.getElementById('you');
  const connEl = document.getElementById('conn');
  const alertEl = document.getElementById('alert');
  const debugEl = document.getElementById('debug');

  let state = {
    board: makeEmptyBoard(),
    turn: 'black',
    legal: [],
    you: side,
    turn_nonce: '',
    phase: 'WaitingWhite'
  };

  initUI();
  connect();

  function initUI() {
    // Columns A..H, Rows 1..8
    ['A','B','C','D','E','F','G','H'].forEach(c => {
      const o = document.createElement('option'); o.value = c; o.textContent = c; colSel.appendChild(o);
    });
    for (let r=1;r<=8;r++) {
      const o = document.createElement('option'); o.value = r; o.textContent = r; rowSel.appendChild(o);
    }
    buildBoardGrid();
    submitBtn.onclick = submitMove;
    infoEl.textContent = `Room ${room} / Side: ${side}`;
    youEl.textContent = `You are: ${side}`;
    connEl.textContent = `Connecting…`;
  }

  function buildBoardGrid() {
    boardEl.innerHTML = '';
    for (let r=0;r<8;r++) {
      const tr = document.createElement('tr');
      for (let c=0;c<8;c++) {
        const td = document.createElement('td');
        td.dataset.rc = `${r},${c}`;
        tr.appendChild(td);
      }
      boardEl.appendChild(tr);
    }
    render();
  }

  function render() {
    // discs
    [...boardEl.querySelectorAll('td')].forEach(td => {
      td.innerHTML = '';
      const [r,c] = td.dataset.rc.split(',').map(Number);
      const v = state.board[r][c];
      if (v === 1 || v === 2) {
        const d = document.createElement('div');
        d.className = `disc ${v===1?'black':'white'}`;
        d.setAttribute('aria-hidden','true');
        td.appendChild(d);
      }
    });
    // hints for legal moves (only for your turn & if you are player)
    if (state.you === state.turn && (state.you==='black'||state.you==='white')) {
      state.legal.forEach(([r,c]) => {
        const td = boardEl.querySelector(`td[data-rc="${r},${c}"]`);
        if (td) {
          const k = document.createElement('div'); k.className = 'hint'; td.appendChild(k);
        }
      });
    }
    turnEl.textContent = `Turn: ${state.turn}`;
    youEl.textContent = `You are: ${state.you}`;
    debugEl.textContent = `Phase=${state.phase} | Legal=${state.legal.length} | Nonce=${state.turn_nonce}`;
  }

  function connect() {
    const u = `/api/room/events?room=${room}&side=${encodeURIComponent(side)}&session=${encodeURIComponent(session)}&lang=${lang}`;
    const ev = new EventSource(u);
    ev.onopen = () => connEl.textContent = 'Connected';
    ev.onerror = () => connEl.textContent = 'Disconnected (retrying…)';

    ev.addEventListener('snapshot', (e) => {
      const data = JSON.parse(e.data);
      state.board = data.board;
      state.turn = data.turn;
      state.legal = data.legal || [];
      state.turn_nonce = data.turn_nonce || '';
      state.phase = data.phase || state.phase;
      alertEl.style.display = 'none';
      render();
    });

    ev.addEventListener('legal_moves', (e) => {
      const data = JSON.parse(e.data);
      state.legal = data.legal || [];
      render();
    });

    ev.addEventListener('move_applied', (e) => {
      const data = JSON.parse(e.data);
      state.board = data.board;
      state.turn = data.turn;
      state.legal = data.legal || [];
      state.turn_nonce = data.turn_nonce || '';
      render();
    });

    ev.addEventListener('opponent_left', (e) => {
      const data = JSON.parse(e.data);
      alertEl.textContent = data.message || 'Your opponent has left.';
      alertEl.style.display = 'block';
      // board clear if provided
      if (data.board) {
        state.board = data.board;
        state.phase = data.phase || state.phase;
        state.legal = [];
        render();
      }
    });

    ev.addEventListener('system_message', (e) => {
      // reserved for future
    });
  }

  async function submitMove() {
    const col = colSel.value;
    const row = rowSel.value;
    const coord = `${col}${row}`;
    const body = { session, coord, turn_nonce: state.turn_nonce };
    const r = await fetch(`/api/room/move?room=${room}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) {
      // ignore
    }
  }

  function makeEmptyBoard() { return Array.from({length:8},()=>Array(8).fill(0)); }
  function genSession(){ return 's_' + Math.random().toString(16).slice(2) + Date.now().toString(16); }
})();