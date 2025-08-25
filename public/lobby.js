(function() {
  const SUP_LANGS = ['en','de','it','fr','es','ja'];
  const navLang = (navigator.language || 'en').toLowerCase();
  const pickLang = SUP_LANGS.find(l => navLang.startsWith(l)) || 'en';

  let i18n = {
    vacant: { en: "Vacant", ja: "空き", de:"Frei", it:"Libero", fr:"Libre", es:"Libre" },
    opponent_left: { en:"Your opponent has left.", ja:"対戦相手が退室しました。", de:"Ihr Gegner hat den Raum verlassen.", it:"Il tuo avversario ha lasciato.", fr:"Votre adversaire a quitté la partie.", es:"Tu oponente ha salido." }
  };

  // If you prefer external file, keep inline minimal fallback.
  // fetch('./i18n/system-messages.json').then(r=>r.json()).then(json=>{ i18n=json; });

  const roomsEl = document.getElementById('rooms');
  const statusEl = document.getElementById('status');
  const resetBtn = document.getElementById('reset');
  const session = genSession();

  const state = { rooms: { 1: vacantRoom(), 2: vacantRoom(), 3: vacantRoom(), 4: vacantRoom() } };

  function vacantRoom() { return { black:null, white:null, observers:0 }; }
  function labelVacant() { return i18n.vacant[pickLang] || i18n.vacant.en; }
  function render() {
    roomsEl.innerHTML = '';
    for (const id of [1,2,3,4]) {
      const r = state.rooms[id];
      const room = document.createElement('div');
      room.className = 'room';
      room.innerHTML = `
        <h2>Room ${id}</h2>
        <div class="seats">
          <div class="seat">
            <div><strong>●</strong> ${r.black ? escapeHtml(r.black) : `<span class="vacant">${labelVacant()}</span>`}</div>
            <div class="btns">
              <button data-room="${id}" data-side="black">Join Black</button>
              <button data-room="${id}" data-side="observer">Observe</button>
            </div>
          </div>
          <div class="seat">
            <div><strong>○</strong> ${r.white ? escapeHtml(r.white) : `<span class="vacant">${labelVacant()}</span>`}</div>
            <div class="btns">
              <button data-room="${id}" data-side="white">Join White</button>
              <button data-room="${id}" data-side="observer">Observe</button>
            </div>
          </div>
        </div>
      `;
      roomsEl.appendChild(room);
    }
    roomsEl.querySelectorAll('button').forEach(btn => {
      btn.onclick = async (e) => {
        const room = e.target.getAttribute('data-room');
        const side = e.target.getAttribute('data-side');
        await seat(room, side);
      };
    });
  }

  async function loadSnapshot() {
    const r = await fetch('/api/lobby/state', { method: 'POST' });
    const json = await r.json();
    state.rooms = json.rooms;
    render();
  }

  function connectSSE() {
    const ev = new EventSource('/api/lobby/events');
    ev.onopen = () => statusEl.textContent = 'Connected';
    ev.onerror = () => statusEl.textContent = 'Disconnected (retrying…)';
    ev.addEventListener('lobby_snapshot', (e) => {
      const data = JSON.parse(e.data);
      state.rooms = data.rooms;
      render();
    });
    ev.addEventListener('room_update', (e) => {
      const data = JSON.parse(e.data);
      state.rooms[data.room] = data.state;
      render();
    });
  }

  async function seat(room, side) {
    const body = { room: Number(room), side, session, lang: pickLang };
    const r = await fetch('/api/lobby/seat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const res = await r.json();
    const finalSide = res.side || side; // server may force observer
    location.href = `/reversi.html?room=${room}&side=${encodeURIComponent(finalSide)}&session=${encodeURIComponent(session)}`;
  }

  resetBtn.onclick = async () => {
    await fetch('/api/lobby/reset', { method:'POST' });
    await loadSnapshot();
  };

  function genSession() {
    return 's_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
  function escapeHtml(s){ return (s||'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  loadSnapshot().then(connectSSE);
})();