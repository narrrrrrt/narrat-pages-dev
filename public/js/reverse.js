// public/js/reverse.js -- v1.1.4
// 目的: v1.1 仕様に合わせて UI を更新。相手の退室はポップアップ→盤面ゼロ→退室→ロビーへ。
// HB(7s)/Beacon/Moveは据え置き。レスポンス本文は読まない（SSE主体）。

(function () {
  // ---- helpers ----
  function qs(k){const u=new URL(location.href);return u.searchParams.get(k)}
  function randId(){return Math.random().toString(16).slice(2,10)}
  function $(s){return document.querySelector(s)}

  // ---- i18n（ポップアップのみ）----
  let MSG={opponent_left:'対戦相手が退出しました'};
  fetch('/i18n/system_messages.json').then(r=>r.json()).then(all=>{
    const lang=(navigator.language||'en').slice(0,2);
    if(all&&all.opponent_left){
      MSG.opponent_left = all.opponent_left[lang] || all.opponent_left.en || MSG.opponent_left;
    }
  }).catch(()=>{});

  // ---- params ----
  const room=Math.max(1,Math.min(4,parseInt(qs('room')||'1',10)));
  const wantSeat=(qs('seat')||'observer'); // black|white|observer
  const sseId=randId();

  // ---- state ----
  let token=''; let mySeat='observer'; let lastStatus=null; let hbTimer=null;

  // ---- UI ----
  const elTurn=$('#turn')||createIndicator();
  const elBoard=$('#board')||createBoard();
  const elLeaveBtn=$('#btn-leave');

  function createIndicator(){const el=document.createElement('div');el.id='turn';el.style.margin='8px 0';document.body.prepend(el);return el}
  function createBoard(){const t=document.createElement('table');t.id='board';t.style.borderCollapse='collapse';t.style.margin='8px 0';const tb=document.createElement('tbody');for(let y=0;y<8;y++){const tr=document.createElement('tr');for(let x=0;x<8;x++){const td=document.createElement('td');td.dataset.xy=String.fromCharCode(97+x)+(y+1);td.style.width='32px';td.style.height='32px';td.style.textAlign='center';td.style.border='1px solid #ccc';td.style.fontSize='20px';td.addEventListener('click',onCellClick);tr.appendChild(td)}tb.appendChild(tr)}t.appendChild(tb);document.body.appendChild(t);return t}

  // ---- join ----
  async function join(){
    const res=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'join',room,seat:wantSeat,sse:sseId})});
    if(!res.ok){alert('Join failed: '+res.status);location.href='/index.html';return}
    token=res.headers.get('X-Play-Token')||'';
    const snap=await res.json().catch(()=>null);
    if(snap&&snap.seat) mySeat=snap.seat;
    startSse();
    if(token) startHeartbeat();
  }

  // ---- SSE ----
  let es=null;
  function startSse(){
    if(es){es.close();es=null}
    const url=`/?room=${room}&seat=${encodeURIComponent(mySeat)}&sse=${encodeURIComponent(sseId)}`;
    es=new EventSource(url);
    es.addEventListener('room_state',ev=>{
      try{
        const snap=JSON.parse(ev.data);
        if(snap.seat) mySeat=snap.seat;
        applySnapshot(snap);
        detectLeaveTransition(snap);
      }catch(e){}
    });
    es.onerror=()=>{ /* 自動再接続に任せる */ };
  }

  // ---- heartbeat (7s) + beacon leave ----
  function startHeartbeat(){
    if(hbTimer) return;
    const send=()=>{ fetch('/api/action',{method:'POST',keepalive:true,headers:{'X-Play-Token':token}}).catch(()=>{}) };
    send(); hbTimer=setInterval(send,7000);

    const beacon=()=>{ try{navigator.sendBeacon('/api/action',JSON.stringify({action:'leave',room,sse:sseId}))}catch{} };
    window.addEventListener('pagehide',beacon);
    window.addEventListener('beforeunload',beacon);
  }

  // ---- board / move ----
  function onCellClick(e){
    const td=e.currentTarget; if(!td||!token) return;
    const pos=td.dataset.xy;
    fetch('/api/move',{method:'POST',headers:{'Content-Type':'application/json','X-Play-Token':token},body:JSON.stringify({room,pos})}).catch(()=>{});
  }

  function renderBoard(board,legal){
    if(!board||!Array.isArray(board.stones)) return;
    const map={}; (legal||[]).forEach(p=>map[p]=true);
    elBoard.querySelectorAll('td[data-xy]').forEach(td=>{
      const x=td.dataset.xy.charCodeAt(0)-97; const y=parseInt(td.dataset.xy.slice(1),10)-1;
      const v=board.stones[y][x];
      td.textContent=(v==='B')?'●':(v==='W'?'○':(map[td.dataset.xy]?'·':''));
      td.style.opacity=map[td.dataset.xy]?'0.5':'1';
    });
  }

  function setTurn(turn){ elTurn.textContent='Turn: '+(turn? (turn==='black'?'●':'○') : '–') }
  function clearBoardToEmpty(){ elBoard.querySelectorAll('td[data-xy]').forEach(td=>{td.textContent='';td.style.opacity='1'}); setTurn(null) }
  function applySnapshot(snap){ renderBoard(snap.board,snap.legal); setTurn(snap.turn); lastStatus=snap.status }

  // ---- leave detection ----
  function detectLeaveTransition(snap){
    if(lastStatus==='playing' && snap.status==='leave' && mySeat!=='observer'){
      alert(MSG.opponent_left);
      clearBoardToEmpty();
      if(token){
        fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Play-Token':token},body:JSON.stringify({action:'leave',room})}).catch(()=>{});
      }
      location.href='/index.html';
    }
  }

  // ---- optional leave button ----
  const elLeaveBtn=$('#btn-leave');
  if(elLeaveBtn){
    elLeaveBtn.addEventListener('click',e=>{
      e.preventDefault();
      if(token){
        fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Play-Token':token},body:JSON.stringify({action:'leave',room})}).finally(()=>location.href='/index.html');
      }else{
        location.href='/index.html';
      }
    });
  }

  // boot
  join();
})();