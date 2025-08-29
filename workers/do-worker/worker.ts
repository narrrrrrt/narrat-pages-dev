// workers/do-worker/worker.ts  v0.8
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

type TokenInfo = { room:number; seat:Seat; sseId?:string };
type RoomState = {
  board: string[];
  status: Status;
  turn: Turn;
  black: string | null;
  white: string | null;
  watchers: number;
  firstMoveLoggedBlack?: boolean;
  firstMoveLoggedWhite?: boolean;
};

const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]] as const;

const slog = (type:string, fields:Record<string,unknown> = {}) => {
  try {
    // Cloudflareのコンソール用（必要最小限）
    console.log(JSON.stringify({
      log: "REVERSI",
      type,
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
  // ▼ 追加: HB短TTL監視用
  lastHbAt = new Map<string, number>();
  hbTimer: any = undefined;

  constructor(state: DurableObjectState, env: Env){
    this.state = state;
    for (const n of [1,2,3,4]) this.rooms.set(n, this.newRoom());
    // HB short TTL sweep timer (every 10s)
    // @ts-ignore
    this.hbTimer = setInterval(()=>{ try { this.sweepHb(); } catch(_e){} }, 10000);
  }

  private newRoom(): RoomState {
    return {
      board: initialBoard(),
      status: 'waiting',
      turn: null,
      black: null,
      white: null,
      watchers: 0,
      firstMoveLoggedBlack: false,
      firstMoveLoggedWhite: false,
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method==='GET' && url.pathname==='/lobby-sse') {
      return this.handleSseLobby();
    }
    if (req.method==='GET' && url.pathname==='/room-sse') {
      const room = Math.max(1, Math.min(4, parseInt(url.searchParams.get('room')||'1',10)));
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
      return json({ ok:true });
    }

    return new Response('Not Found', {status:404});
  }

  // …（中略：SSEハンドラ、スナップショット、合法手計算等 既存実装）…

  async handleAction(req:Request): Promise<Response> {
    const body = await req.json().catch(()=>({}));

    // ▼ 追加: Heartbeat（空POST + X-Play-Token もしくは action==='hb'）
    const action = (body.action||'').toLowerCase();
    const hbToken = req.headers.get('X-Play-Token') || '';
    if ((!action || action==='hb') && hbToken){
      this.lastHbAt.set(hbToken, Date.now());
      slog('HB', { token: tokShort(hbToken) });
      return new Response(null, { status: 204 });
    }

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

          // ★ 両者が揃った瞬間に初期化して再開（leave からの復帰含む）
          if (r.black && r.white){
            r.board = initialBoard();
            r.status='playing';
            r.turn='black';
            r.firstMoveLoggedBlack = false;
            r.firstMoveLoggedWhite = false;
          }

          slog('JOIN', { room, seat: wantSeat, token: tokShort(token!) });
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
        if (info){ this.leaveByTokenInfo(info); this.lastHbAt.delete(token); }
        const hdr = new Headers({'Content-Type':'application/json','X-Log-Event':'token-deleted'});
        return new Response(JSON.stringify(this.snapshot(room)), {status:200, headers:hdr});
      }else if (sseId && this.sseMap){
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

  // v0.8: 片側が抜けたら status='leave' + ゼロ盤面 + turn=null を即配信
  //       両者不在になったら waiting + 初期盤面に戻す
  leaveByTokenInfo(info:TokenInfo){
    const r = this.rooms.get(info.room)!;
    if (!r) return;

    if (info.seat==='black') r.black=null;
    if (info.seat==='white') r.white=null;

    if (!r.black && !r.white){
      r.board = initialBoard();
      r.turn = null;
      r.status = 'waiting';
      r.firstMoveLoggedBlack = false;
      r.firstMoveLoggedWhite = false;
    } else {
      // 片側が残っている → leave + ゼロ盤面
      r.board = zeroBoard();
      r.turn = null;
      r.status = 'leave';
      r.firstMoveLoggedBlack = false;
      r.firstMoveLoggedWhite = false;
    }

    this.broadcastLobby(); this.broadcastRoom(info.room);
  }

  // ▼ 追加: HBタイムアウトのスイープ
  sweepHb(){
    const now = Date.now();
    const TTL_HB = 25000; // 25s
    for (const [token, ts] of this.lastHbAt){
      if (now - ts > TTL_HB){
        const info = this.tokenMap.get(token);
        if (info){
          slog('LEAVE_TIMEOUT_HB', { room: info.room, seat: info.seat, token: tokShort(token) });
          this.leaveByTokenInfo(info);
        }
        this.lastHbAt.delete(token);
      }
    }
  }

  findBySseId(sseId:string){
    return this.sseMap.get(sseId);
  }

  snapshotAll(){
    const pack: any = { rooms: {} as any, ts: Date.now() };
    for (const n of [1,2,3,4]){
      const r = this.rooms.get(n)!;
      pack.rooms[n] = {
        status: r.status,
        seats: { black: !!r.black, white: !!r.white },
        watchers: r.watchers
      };
    }
    return pack;
  }

  snapshot(room:number, seat?:Seat){
    const r = this.rooms.get(room)!;
    return {
      room,
      seat,
      status: r.status,
      turn: r.turn,
      board: { size: 8, stones: r.board },
      legal: legalMoves(r.board, r.turn),
      watchers: r.watchers
    };
  }

  broadcastLobby(){
    const pack = this.snapshotAll();
    for (const c of this.lobbyClients){
      try { c.controller.enqueue(encodeSse('room_state', pack)); } catch {}
    }
  }

  broadcastRoom(room:number){
    const rset = this.roomClients.get(room);
    if (!rset) return;
    const snap = this.snapshot(room);
    for (const c of rset){
      try { c.controller.enqueue(encodeSse('room_state', snap)); } catch {}
    }
  }
}

// ===== ヘルパ =====

function encodeSse(event:string, data:any){
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(obj:any, code=200){
  return new Response(JSON.stringify(obj), { status:code, headers:{'Content-Type':'application/json'} });
}

function genToken(){
  return Math.random().toString(36).slice(2,10);
}

function tokShort(t:string){ return t.slice(0,2) + "******"; }

function initialBoard(): string[]{
  const rows = Array.from({length:8}, ()=>'--------');
  const mid=3;
  const r = rows.map(x=>x.split(''));
  r[mid][mid]='W'; r[mid+1][mid+1]='W';
  r[mid][mid+1]='B'; r[mid+1][mid]='B';
  return r.map(a=>a.join(''));
}

function zeroBoard(): string[]{
  return Array.from({length:8}, ()=>'--------');
}

function posToXY(pos:string): [number,number]{
  const x = pos.charCodeAt(0)-97;
  const y = parseInt(pos.slice(1),10)-1;
  return [x,y];
}

function legalMoves(board:string[], turn:Turn): string[]{
  if (!turn) return [];
  const me = turn==='black'?'B':'W';
  const op = turn==='black'?'W':'B';
  const moves = new Set<string>();
  const rows = board.map(x=>x.split(''));
  const inside = (i:number,j:number)=>i>=0&&i<8&&j>=0&&j<8;

  for (let y=0;y<8;y++){
    for (let x=0;x<8;x++){
      if (rows[y][x]!=='-') continue;
      for (const [dx,dy] of DIRS){
        let i=x+dx, j=y+dy, seen=0;
        while (inside(i,j) && rows[j][i]===op){ i+=dx; j+=dy; seen++; }
        if (seen>0 && inside(i,j) && rows[j][i]===me){ moves.add(String.fromCharCode(97+x)+(y+1)); break; }
      }
    }
  }
  return [...moves].sort();
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
      if (ch===me && buf.length>0){ for (const [bi,bj] of buf){ rows[bj][bi]=me; } flipped+=buf.length; }
      break;
    }
  }
  if (flipped===0) return board;
  rows[y][x]=me;
  return rows.map(a=>a.join(''));
}