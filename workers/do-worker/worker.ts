// workers/do-worker/worker.ts  v0.7
export interface Env {
  REVERSI_HUB: DurableObjectNamespace;
  LOG_BUCKET?: R2Bucket; // あっても使わない（R2保存はPages側ミドルでやる）
}

type Seat = 'black'|'white'|'observer';
type Turn = 'black'|'white'|null;
type Status = 'waiting'|'playing'|'leave'|'finished';

type Client = {
  controller: ReadableStreamDefaultController;
  seat: Seat;
  room: number;
  sseId?: string;
};

type RoomState = {
  black?: string;
  white?: string;
  watchers: number;
  board: string[];
  turn: Turn;
  status: Status;
  // v0.6+: 各色の「最初の一手」ログ済みフラグ
  firstMoveLoggedBlack: boolean;
  firstMoveLoggedWhite: boolean;
};

type TokenInfo = { room: number, seat: Exclude<Seat,'observer'>, sseId?: string };

// ---- 盤面ユーティリティ ----
function initialBoard(): string[] {
  const rows = Array.from({length:8}, _ => '--------');
  const set = (x:number,y:number,ch:string) => { const r = rows[y].split(''); r[x]=ch; rows[y]=r.join(''); };
  set(3,3,'W'); set(4,4,'W'); set(3,4,'B'); set(4,3,'B');
  return rows;
}
function posToXY(pos:string): [number,number] {
  const col = pos[0].toLowerCase().charCodeAt(0) - 97;
  const row = parseInt(pos.slice(1),10) - 1;
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
        let i=x+dx, j=y+dy, seen=false;
        while (i>=0 && i<8 && j>=0 && j<8){
          const ch = board[j][i];
          if (ch===op){ seen=true; i+=dx; j+=dy; continue; }
          if (ch===me && seen){ ok=true; break; }
          break;
        }
        if (ok) break;
      }
      if (ok) moves.push(String.fromCharCode(97+x)+(y+1));
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
    const buf:[number,number][]=[];
    while (i>=0 && i<8 && j>=0 && j<8){
      const ch = rows[j][i];
      if (ch===op){ buf.push([i,j]); i+=dx; j+=dy; continue; }
      if (ch===me && buf.length){ for (const [fx,fy] of buf){ rows[fy][fx]=me; flipped++; } }
      break;
    }
  }
  if (!flipped) return board;
  rows[y][x]=me;
  return rows.map(r=>r.join(''));
}

function countBW(board:string[]): {B:number,W:number}{
  let B=0,W=0; for (const r of board) for (const ch of r){ if(ch==='B')B++; else if(ch==='W')W++; }
  return {B,W};
}

// ---- ログユーティリティ ----
const tokShort = (t?:string)=> t ? `${t.slice(0,2)}******` : '';

// 許可するログタイプ（環境変数 LOG_TYPES が無ければ v0.7 既定）
const ALLOW = new Set<string>((
  (globalThis as any).LOG_TYPES || 'MOVE_FIRST_BLACK,MOVE_FIRST_WHITE,LEAVE_BLACK,LEAVE_WHITE'
).split(',').map(s=>s.trim()).filter(Boolean));

// v0.7: 共通フィールド log="REVERSI" を付与（ダッシュボードで log=REVERSI で一発フィルタ）
const slog = (type: string, fields: Record<string, any> = {}) => {
  if (!ALLOW.has(type)) return;
  try {
    console.log(JSON.stringify({
      log: 'REVERSI',
      type,
      t: Date.now(),
      ...fields
    }));
  } catch {}
};

export class ReversiHub {
  state: DurableObjectState;
  rooms = new Map<number,RoomState>();
  lobbyClients = new Set<Client>();
  roomClients = new Map<number, Set<Client>>([[1,new Set],[2,new Set],[3,new Set],[4,new Set]]);
  tokenMap = new Map<string,TokenInfo>();
  sseMap   = new Map<string, TokenInfo>();

  constructor(state: DurableObjectState, env: Env){
    this.state = state;
    for (const n of [1,2,3,4]) this.rooms.set(n, this.newRoom());
  }

  private newRoom(): RoomState {
    return {
      watchers:0,
      board: initialBoard(),
      turn:null,
      status:'waiting',
      firstMoveLoggedBlack:false,
      firstMoveLoggedWhite:false
    };
  }

  snapshot(room:number, seat?:Seat){
    const r = this.rooms.get(room)!;
    const legal = r.turn ? legalMoves(r.board, r.turn) : [];
    return { room, seat, status:r.status, turn:r.turn,
      board:{size:8, stones:r.board}, legal, watchers:r.watchers,
      seats:{ black: !!r.black, white: !!r.white } };
  }
  snapshotAll(){
    const pack:any = {}; for (const n of [1,2,3,4]){ const r=this.rooms.get(n)!; pack[n]={ seats:{black:!!r.black,white:!!r.white}, watchers:r.watchers, status:r.status }; }
    return { rooms: pack, ts: Date.now() };
  }

  broadcastRoom(room:number){
    const snap = JSON.stringify(this.snapshot(room));
    const set = this.roomClients.get(room)!;
    for (const c of set) { try{ c.controller.enqueue(encoder(`event: room_state\ndata: ${snap}\n\n`)); }catch{} }
  }
  broadcastLobby(){
    const snap = JSON.stringify(this.snapshotAll());
    for (const c of this.lobbyClients) { try{ c.controller.enqueue(encoder(`event: room_state\ndata: ${snap}\n\n`)); }catch{} }
  }

  startPinger(set:Set<Client>){
    const timer = setInterval(()=>{
      for (const c of set){ try{ c.controller.enqueue(encoder(`event: ping\ndata: ${Date.now()}\n\n`)); }catch{} }
    }, 3000);
    this.state.waitUntil(new Promise<void>(resolve=>{
      const iv=setInterval(()=>{ if (set.size===0){ clearInterval(timer); clearInterval(iv); resolve(); } },5000);
    }));
  }

  async fetch(req:Request): Promise<Response>{
    const url = new URL(req.url);
    if (url.pathname==='/sse' && req.method==='GET'){
      const roomQ = url.searchParams.get('room') || 'all';
      if (roomQ==='all') return this.handleSseLobby();
      const room = Math.max(1, Math.min(4, parseInt(roomQ,10) || 1));
      const seat = (url.searchParams.get('seat') || 'observer') as Seat;
      const sseId = url.searchParams.get('sse') || undefined;
      return this.handleSseRoom(room, seat, sseId);
    }
    if (url.pathname==='/action' && req.method==='POST') return this.handleAction(req);
    if (url.pathname==='/move'   && req.method==='POST') return this.handleMove(req);
    if (url.pathname==='/admin'  && req.method==='POST') {
      for (const n of [1,2,3,4]) this.rooms.set(n, this.newRoom());
      slog('ADMIN_RESET', {});
      this.broadcastLobby(); for (const n of [1,2,3,4]) this.broadcastRoom(n);
      return json({ok:true});
    }
    return new Response('OK', {status:200});
  }

  handleSseLobby(): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        const client: Client = { controller, seat:'observer', room:0 };
        this.lobbyClients.add(client);
        controller.enqueue(encoder('event: room_state\ndata: '+JSON.stringify(this.snapshotAll())+'\n\n'));
        if (this.lobbyClients.size===1) this.startPinger(this.lobbyClients);
        slog('SSE_LOBBY_ADD', { total: this.lobbyClients.size });
      },
      cancel: () => { slog('SSE_LOBBY_CANCEL', {}); }
    });
    return new Response(stream, sseHeaders());
  }

  handleSseRoom(room:number, seat:Seat, sseId?:string): Response {
    const clients = this.roomClients.get(room)!;
    const stream = new ReadableStream({
      start: (controller) => {
        const c: Client = { controller, seat, room, sseId };
        clients.add(c);
        if (seat==='observer'){ const r=this.rooms.get(room)!; r.watchers++; this.broadcastLobby(); }
        controller.enqueue(encoder('event: room_state\ndata: '+JSON.stringify(this.snapshot(room, seat))+'\n\n'));
        if (clients.size===1) this.startPinger(clients);
        slog('SSE_ROOM_ADD', { room, seat, sseId, total: clients.size });
      }
    });

    const origCancel = stream.cancel?.bind(stream);
    stream.cancel = async (reason?:any) => {
      try{
        for (const c of Array.from(this.roomClients.get(room)!)){
          if (c.seat===seat && c.sseId===sseId){ this.roomClients.get(room)!.delete(c); break; }
        }
        const r = this.rooms.get(room)!;
        if (seat==='observer'){
          r.watchers=Math.max(0,(r.watchers||0)-1);
          this.broadcastLobby(); this.broadcastRoom(room);
        }
        else if (sseId){
          const info = this.findBySseId(sseId);
          if (info && info.room===room) {
            this.leaveByTokenInfo(info); // 内部で LEAVE_* を出す
          }
        }
        slog('SSE_ROOM_DEL', { room, seat, total: this.roomClients.get(room)!.size });
      }catch(e){ console.warn('cancel err', e); }
      if (origCancel) await origCancel(reason);
    };

    return new Response(stream, sseHeaders());
  }

  async handleAction(req:Request): Promise<Response> {
    const body = await req.json().catch(()=>({}));
    const action = (body.action||'').toLowerCase();
    const room = Math.max(1, Math.min(4, parseInt(body.room,10)||1));
    const wantSeat = (body.seat || 'observer') as Seat;
    const sseId = body.sse as (string|undefined);
    const r = this.rooms.get(room)!;

    if (action==='join'){
      let seat: Seat = wantSeat;
      let token: string | undefined;
      if (wantSeat==='black' || wantSeat==='white'){
        const occ = wantSeat==='black' ? r.black : r.white;
        if (!occ){
          token = genToken();
          if (wantSeat==='black') r.black = token; else r.white = token;
          this.tokenMap.set(token, { room, seat: wantSeat, sseId });
          if (sseId) this.sseMap.set(sseId, { room, seat: wantSeat });
          if (r.black && r.white){ r.status='playing'; r.turn='black'; }
          slog('JOIN', { room, seat: wantSeat, token: tokShort(token), seats:{B:!!r.black,W:!!r.white}, status:r.status, turn:r.turn });
        } else {
          seat = 'observer';
          slog('JOIN_TO_OBS', { room, want: wantSeat });
        }
      }else{
        seat='observer';
        slog('JOIN_OBS', { room });
      }
      const hdr = new Headers({'Content-Type':'application/json'});
      if (token) hdr.set('X-Play-Token', token);
      this.broadcastLobby(); this.broadcastRoom(room);
      return new Response(JSON.stringify(this.snapshot(room, seat)), {status:200, headers:hdr});
    }

    if (action==='leave'){
      const token = req.headers.get('X-Play-Token') || '';
      if (token){
        const info = this.tokenMap.get(token);
        if (info){ this.leaveByTokenInfo(info); }
        const hdr = new Headers({'Content-Type':'application/json','X-Log-Event':'token-deleted'});
        return new Response(JSON.stringify(this.snapshot(room)), {status:200, headers:hdr});
      }else if (sseId && this.sseMap.has(sseId)){
        const info = this.sseMap.get(sseId)!;
        this.leaveByTokenInfo(info);
        const hdr = new Headers({'Content-Type':'application/json','X-Log-Event':'token-deleted'});
        return new Response(JSON.stringify(this.snapshot(info.room)), {status:200, headers:hdr});
      }else{
        return json({ok:true});
      }
    }

    return new Response('Bad Request', {status:400});
  }

  // v0.6+: 離脱時ログはここで一元出力（LEAVE_BLACK / LEAVE_WHITE）
  leaveByTokenInfo(info:TokenInfo){
    const r = this.rooms.get(info.room)!;

    if (info.seat==='black' && r.black){
      slog('LEAVE_BLACK', { room: info.room });
      this.tokenMap.delete(r.black); r.black=undefined;
    }
    if (info.seat==='white' && r.white){
      slog('LEAVE_WHITE', { room: info.room });
      this.tokenMap.delete(r.white); r.white=undefined;
    }

    // 盤面とフラグを初期化
    r.board = initialBoard(); r.turn=null; r.status='waiting';
    r.firstMoveLoggedBlack = false;
    r.firstMoveLoggedWhite = false;

    // sseId 紐付きも掃除
    for (const [k,v] of Array.from(this.sseMap.entries()))
      if (v.room===info.room && v.seat===info.seat) this.sseMap.delete(k);

    this.broadcastLobby(); this.broadcastRoom(info.room);
  }

  findBySseId(sseId:string){ return this.sseMap.get(sseId); }

  async handleMove(req:Request): Promise<Response>{
    const token = req.headers.get('X-Play-Token') || '';
    const body = await req.json().catch(()=>({}));
    const room = Math.max(1, Math.min(4, parseInt(body.room,10)||1));
    const pos: string = (body.pos || '').toLowerCase();
    const r = this.rooms.get(room)!;

    const info = this.tokenMap.get(token);
    if (!info || info.room!==room) return json({error:'unauthorized'}, 403);
    if (r.status!=='playing' || !r.turn) return json(this.snapshot(room));
    if (info.seat !== r.turn) return json(this.snapshot(room));

    const legals = legalMoves(r.board, r.turn);
    if (!legals.includes(pos)) return json(this.snapshot(room));

    // 着手
    r.board = applyMove(r.board, pos, r.turn);

    // 各色の「最初の一手」だけ MOVE_FIRST_* を出す
    if (info.seat==='black' && !r.firstMoveLoggedBlack) {
      r.firstMoveLoggedBlack = true;
      slog('MOVE_FIRST_BLACK', { room, pos });
    } else if (info.seat==='white' && !r.firstMoveLoggedWhite) {
      r.firstMoveLoggedWhite = true;
      slog('MOVE_FIRST_WHITE', { room, pos });
    }

    // 手番更新
    const next = r.turn==='black' ? 'white' : 'black';
    const nextLegal = legalMoves(r.board, next);
    if (nextLegal.length>0){ r.turn = next; }
    else {
      const curLegal = legalMoves(r.board, r.turn);
      if (curLegal.length===0){ r.turn=null; r.status='finished'; }
    }

    // 参考ログ（既定では抑制。必要なら LOG_TYPES に MOVE を追加）
    const {B,W}=countBW(r.board);
    slog('MOVE', { room, seat: info.seat, pos, nextTurn: r.turn, counts: { B, W } });

    const hdr = new Headers({'Content-Type':'application/json'});
    const snap = this.snapshot(room);
    this.broadcastRoom(room); this.broadcastLobby();
    return new Response(JSON.stringify(snap), {status:200, headers:hdr});
  }
}

function sseHeaders(): ResponseInit {
  return { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control':'no-cache, no-transform', 'Connection':'keep-alive', 'Access-Control-Allow-Origin':'*' } };
}
function encoder(s:string){ return new TextEncoder().encode(s); }
function json(data:any, code=200){ return new Response(JSON.stringify(data), {status:code, headers:{'Content-Type':'application/json'}}); }
function genToken(): string { return Math.random().toString(36).slice(2,10); }

export default {
  async fetch(request: Request, env: Env) {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  }
} satisfies ExportedHandler<Env>;