// workers/do-worker/worker.ts
export interface Env {
  REVERSI_HUB: DurableObjectNamespace;
}

type Seat = 'black'|'white'|'observer';
type Turn = 'black'|'white'|null;
type Status = 'waiting'|'playing'|'leave'|'finished';

type Client = {
  controller: ReadableStreamDefaultController;
  seat: Seat;           // 観戦かどうかの集計に使う
  room: number;         // 1..4, or 0 for lobby(all)
  sseId?: string;       // SSE接続ID
};

type RoomState = {
  black?: string;       // token
  white?: string;       // token
  watchers: number;     // 観戦SSE接続数（プレイヤーは含めない）
  board: string[];      // 8行, '-', 'B', 'W'
  turn: Turn;
  status: Status;
};

type TokenInfo = { room: number, seat: Exclude<Seat,'observer'>, sseId?: string };

function initialBoard(): string[] {
  const rows = Array.from({length:8}, _ => '--------');
  const set = (x:number,y:number,ch:string) => {
    const row = rows[y].split('');
    row[x] = ch;
    rows[y] = row.join('');
  };
  set(3,3,'W'); set(4,4,'W');
  set(3,4,'B'); set(4,3,'B');
  return rows;
}

function cloneBoard(b:string[]): string[] { return b.slice(); }

function posToXY(pos:string): [number,number] {
  const col = pos[0].toLowerCase().charCodeAt(0) - 97; // a..h -> 0..7
  const row = parseInt(pos.slice(1),10) - 1; // 1..8 -> 0..7
  return [col,row];
}

const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

function legalMoves(board:string[], turn:Exclude<Turn,null>): string[] {
  const me = turn==='black'?'B':'W';
  const op = turn==='black'?'W':'B';
  const moves: string[] = [];
  for (let y=0; y<8; y++){
    for (let x=0; x<8; x++){
      if (board[y][x] !== '-') continue;
      let ok = false;
      for (const [dx,dy] of DIRS){
        let i=x+dx, j=y+dy, seenOp=false;
        while (i>=0 && i<8 && j>=0 && j<8){
          const ch = board[j][i];
          if (ch === op){ seenOp=true; i+=dx; j+=dy; continue; }
          if (ch === me && seenOp){ ok=true; break; }
          break;
        }
        if (ok) break;
      }
      if (ok) moves.push(String.fromCharCode(97+x) + (y+1));
    }
  }
  return moves.sort();
}

function applyMove(board:string[], pos:string, turn:Exclude<Turn,null>): string[] {
  const [x,y] = posToXY(pos);
  const me = turn==='black'?'B':'W';
  const op = turn==='black'?'W':'B';
  if (board[y][x] !== '-') return board;
  const rows = board.map(r=>r.split(''));
  let flipped = 0;
  for (const [dx,dy] of DIRS){
    let i=x+dx, j=y+dy;
    const toFlip: [number,number][] = [];
    while (i>=0 && i<8 && j>=0 && j<8){
      const ch = rows[j][i];
      if (ch === op){ toFlip.push([i,j]); i+=dx; j+=dy; continue; }
      if (ch === me && toFlip.length){ for (const [fx,fy] of toFlip) { rows[fy][fx] = me; flipped++; } }
      break;
    }
  }
  if (flipped===0) return board; // 非合法（保険）
  rows[y][x] = me;
  return rows.map(a=>a.join(''));
}

function countBW(board:string[]): {B:number,W:number} {
  let B=0,W=0;
  for (const row of board){
    for (const ch of row){ if (ch==='B') B++; else if (ch==='W') W++; }
  }
  return {B,W};
}

export class ReversiHub {
  state: DurableObjectState;
  rooms: Map<number,RoomState>;
  lobbyClients: Set<Client>;
  roomClients: Map<number, Set<Client>>;
  tokenMap: Map<string,TokenInfo>;
  sseMap: Map<string, TokenInfo>; // sseId → TokenInfo（JOINで登録）

  constructor(state: DurableObjectState, env: Env){
    this.state = state;
    this.rooms = new Map();
    for (const n of [1,2,3,4]) {
      this.rooms.set(n, { watchers:0, board: initialBoard(), turn: null, status:'waiting' });
    }
    this.lobbyClients = new Set();
    this.roomClients = new Map([[1,new Set],[2,new Set],[3,new Set],[4,new Set]]);
    this.tokenMap = new Map();
    this.sseMap   = new Map();
  }

  // 便利：スナップショット生成
  snapshot(room: number, seat?: Seat){
    const r = this.rooms.get(room)!;
    const legal = r.turn ? legalMoves(r.board, r.turn) : [];
    return {
      room,
      seat,
      status: r.status,
      turn: r.turn,
      board: { size: 8, stones: r.board },
      legal,
      watchers: r.watchers,
      seats: { black: !!r.black, white: !!r.white }
    };
  }
  snapshotAll(){
    const pack = {};
    for (const n of [1,2,3,4]) {
      const r = this.rooms.get(n)!;
      pack[n] = { seats: { black: !!r.black, white: !!r.white }, watchers: r.watchers, status: r.status };
    }
    return { rooms: pack, ts: Date.now() };
  }

  broadcastRoom(room:number){
    const snap = JSON.stringify(this.snapshot(room));
    const clients = this.roomClients.get(room)!;
    for (const c of clients){
      try { c.controller.enqueue(encoder(`event: room_state\ndata: ${snap}\n\n`)); } catch {}
    }
  }
  broadcastLobby(){
    const snap = JSON.stringify(this.snapshotAll());
    for (const c of this.lobbyClients){
      try { c.controller.enqueue(encoder(`event: room_state\ndata: ${snap}\n\n`)); } catch {}
    }
  }

  // ping（切断検知の補助）
  startPinger(set: Set<Client>){
    const timer = setInterval(()=>{
      for (const c of set){
        try { c.controller.enqueue(encoder(`event: ping\ndata: ${Date.now()}\n\n`)); } catch {}
      }
    }, 3000);
    this.state.waitUntil(new Promise<void>(resolve=>{
      // 全クライアントが空になったら止める（軽量実装）
      const iv = setInterval(()=>{
        if (set.size===0){ clearInterval(iv); clearInterval(timer); resolve(); }
      }, 5000);
    }));
  }

  // ===== Handlers =====
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/sse' && req.method === 'GET') {
      const roomQ = url.searchParams.get('room') || 'all';
      if (roomQ === 'all') return this.handleSseLobby();
      const room = Math.max(1, Math.min(4, parseInt(roomQ,10)||1));
      const seat = (url.searchParams.get('seat') || 'observer') as Seat;
      const sseId = url.searchParams.get('sse') || undefined;
      return this.handleSseRoom(room, seat, sseId);
    }

    if (url.pathname === '/action' && req.method === 'POST') {
      return this.handleAction(req);
    }

    if (url.pathname === '/move' && req.method === 'POST') {
      return this.handleMove(req);
    }

    if (url.pathname === '/admin' && req.method === 'POST') {
      for (const n of [1,2,3,4]) { this.rooms.set(n, { watchers:0, board: initialBoard(), turn:null, status:'waiting' }); }
      this.broadcastLobby();
      for (const n of [1,2,3,4]) this.broadcastRoom(n);
      return json({ ok:true });
    }

    return new Response('OK', { status: 200 });
  }

  // --- SSE: Lobby ---
  handleSseLobby(): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        const client: Client = { controller, seat: 'observer', room: 0 };
        this.lobbyClients.add(client);
        // 初回状態
        controller.enqueue(encoder('event: room_state\ndata: ' + JSON.stringify(this.snapshotAll()) + '\n\n'));
        // ping
        if (this.lobbyClients.size === 1) this.startPinger(this.lobbyClients);
      },
      cancel: () => { /* GCは自動で十分 */ }
    });
    // close時
    stream.cancel = () => { /* noop */ };

    return new Response(stream, sseHeaders());
  }

  // --- SSE: Room ---
  handleSseRoom(room:number, seat:Seat, sseId?: string): Response {
    const clients = this.roomClients.get(room)!;
    const stream = new ReadableStream({
      start: (controller) => {
        const client: Client = { controller, seat, room, sseId };
        clients.add(client);
        if (seat === 'observer') {
          const r = this.rooms.get(room)!; r.watchers++; this.broadcastLobby();
        }
        // 初回スナップショット（seat を含める）
        controller.enqueue(encoder('event: room_state\ndata: ' + JSON.stringify(this.snapshot(room, seat)) + '\n\n'));
        if (clients.size === 1) this.startPinger(clients);
      },
      cancel: () => { /* noop */ }
    });

    // onclose: 観戦SSE数を減算、JOIN ひも付けがあれば自動 leave
    const originalCancel = stream.cancel?.bind(stream);
    stream.cancel = async (reason?: any) => {
      try{
        const r = this.rooms.get(room)!;
        if (this.roomClients.get(room)!.size > 0) {
          // remove client
          for (const c of Array.from(this.roomClients.get(room)!)) {
            if (c.seat===seat && c.sseId===sseId) { this.roomClients.get(room)!.delete(c); break; }
          }
        }
        if (seat === 'observer') {
          r.watchers = Math.max(0, (r.watchers||0) - 1);
          this.broadcastLobby();
          this.broadcastRoom(room);
        } else if (sseId) {
          // SSE切断によりプレイヤーを退室扱い（トークン不要）
          const info = this.findBySseId(sseId);
          if (info && info.room === room) {
            this.leaveByTokenInfo(info);
          }
        }
      }catch(_){}
      if (originalCancel) await originalCancel(reason);
    };

    return new Response(stream, sseHeaders());
  }

  // --- join/leave ---
  async handleAction(req: Request): Promise<Response> {
    const body = await req.json().catch(()=>({}));
    const action = (body.action || '').toLowerCase();
    const room = Math.max(1, Math.min(4, parseInt(body.room,10)||1));
    const wantSeat = ((body.seat || 'observer') as Seat);
    const sseId = body.sse as (string|undefined);
    const r = this.rooms.get(room)!;

    if (action === 'join') {
      let seat: Seat = wantSeat;
      let token: string | undefined;

      if (wantSeat === 'black' || wantSeat === 'white') {
        const occupied = (wantSeat==='black'? r.black : r.white);
        if (!occupied) {
          token = genToken();
          if (wantSeat === 'black') r.black = token; else r.white = token;
          this.tokenMap.set(token, { room, seat: wantSeat, sseId });
          if (sseId) this.sseMap.set(sseId, { room, seat: wantSeat }); // 紐付け（トークン不要で特定可）
          // 対局開始判定
          if (r.black && r.white) { r.status = 'playing'; r.turn = 'black'; }
        } else {
          // 埋まっていたので観戦にフォールバック
          seat = 'observer';
        }
      } else {
        seat = 'observer';
      }

      const hdrs = new Headers({'Content-Type':'application/json'});
      if (token) hdrs.set('X-Play-Token', token);

      // ロビー＆部屋に即反映
      this.broadcastLobby();
      this.broadcastRoom(room);

      return new Response(JSON.stringify(this.snapshot(room, seat)), { status:200, headers: hdrs });
    }

    if (action === 'leave') {
      const token = req.headers.get('X-Play-Token') || '';
      if (token) {
        const info = this.tokenMap.get(token);
        if (info) { this.leaveByTokenInfo(info); }
        const hdrs = new Headers({'Content-Type':'application/json','X-Log-Event':'token-deleted'});
        return new Response(JSON.stringify(this.snapshot(room)), { status:200, headers: hdrs });
      } else if (sseId && this.sseMap.has(sseId)) {
        // トークン無し（sendBeacon保険）。sseIdからプレイヤー特定。
        const info = this.sseMap.get(sseId)!;
        this.leaveByTokenInfo(info);
        const hdrs = new Headers({'Content-Type':'application/json','X-Log-Event':'token-deleted'});
        return new Response(JSON.stringify(this.snapshot(info.room)), { status:200, headers: hdrs });
      } else {
        return json({ ok:true });
      }
    }

    return new Response('Bad Request', { status:400 });
  }

  leaveByTokenInfo(info: TokenInfo){
    const r = this.rooms.get(info.room)!;
    if (info.seat === 'black' && r.black) { this.tokenMap.delete(r.black); r.black = undefined; }
    if (info.seat === 'white' && r.white) { this.tokenMap.delete(r.white); r.white = undefined; }
    // 対局リセット（設計：「プレイヤー退出 → ポップアップ → 盤面ゼロ → leave → waiting」を簡易化）
    r.board = initialBoard(); r.turn = null; r.status = 'waiting';
    // 紐付け破棄
    for (const [k,v] of Array.from(this.sseMap.entries())) if (v.room===info.room && v.seat===info.seat) this.sseMap.delete(k);
    // 反映
    this.broadcastLobby();
    this.broadcastRoom(info.room);
  }

  findBySseId(sseId:string): TokenInfo | undefined {
    return this.sseMap.get(sseId);
  }

  // --- move ---
  async handleMove(req: Request): Promise<Response> {
    const token = req.headers.get('X-Play-Token') || '';
    const body = await req.json().catch(()=>({}));
    const room = Math.max(1, Math.min(4, parseInt(body.room,10)||1));
    const pos: string = (body.pos || '').toLowerCase();
    const r = this.rooms.get(room)!;

    const info = this.tokenMap.get(token);
    if (!info || info.room !== room) return json({ error:'unauthorized' }, 403);
    if (r.status !== 'playing' || !r.turn) return json(this.snapshot(room));

    // 手番チェック
    const seatTurn: Seat = r.turn;
    if (info.seat !== seatTurn) return json(this.snapshot(room), 200);

    const legals = legalMoves(r.board, r.turn);
    if (!legals.includes(pos)) return json(this.snapshot(room), 200);

    // 反転
    r.board = applyMove(r.board, pos, r.turn);

    // 手番移行とパス/終局
    const next: Exclude<Turn,null> = r.turn === 'black' ? 'white' : 'black';
    const nextLegal = legalMoves(r.board, next);
    if (nextLegal.length > 0) {
      r.turn = next;
    } else {
      const curLegal = legalMoves(r.board, r.turn);
      if (curLegal.length > 0) {
        // 相手パス：手番維持
        r.turn = r.turn;
      } else {
        // 双方パス → 終局
        r.turn = null; r.status = 'finished';
      }
    }

    // 反映（初手ログヘッダ）
    const hdrs = new Headers({'Content-Type':'application/json'});
    if (pos && (r.board.join('').match(/B|W/g)||[]).length <= 5) hdrs.set('X-Log-Event','first-move');

    const snap = this.snapshot(room);
    this.broadcastRoom(room);
    this.broadcastLobby();
    return new Response(JSON.stringify(snap), { status:200, headers: hdrs });
  }
}

// ===== Utilities =====
function sseHeaders(): ResponseInit {
  return {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  };
}
function encoder(s: string){ return new TextEncoder().encode(s); }
function json(data:any, code=200){ return new Response(JSON.stringify(data), { status: code, headers:{'Content-Type':'application/json'} }); }
function genToken(): string { return Math.random().toString(36).slice(2,10); }

// default export（設計書の注意事項どおり）
export default {
  async fetch(request: Request, env: Env) {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Env>;