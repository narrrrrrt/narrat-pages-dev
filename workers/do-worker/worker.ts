// workers/do-worker/worker.ts  -- v1.1.1 y2 Step1 (HB/短TTL監視, SSE ping disabled)
import { json, sseHeaders, encoder, tokShort, genToken, initialBoard } from './utils';
type Seat = 'black'|'white'|'observer';
type Status = 'waiting'|'playing'|'leave'|'finished';

type TokenInfo = { room:number; seat:Seat; sseId?:string };
type Client = { controller:ReadableStreamDefaultController; seat:Seat; room:number; sseId?:string };

declare const slog: (type:string, fields?:Record<string,any>) => void;

export class ReversiHub {
  state: DurableObjectState;
  REVERSI_HUB: DurableObjectNamespace;
  rooms = new Map<number, any>();
  tokenMap = new Map<string, TokenInfo>();
  sseMap = new Map<string, TokenInfo>();
  lobbyClients = new Set<Client>();
  roomClients = new Map<number, Set<Client>>();

  lastHbAt = new Map<string, number>(); // Step1: HB timestamps
  hbTimerStarted = false;

  constructor(state: DurableObjectState, env: any){
    this.state = state;
    (this as any).env = env;
    for (const n of [1,2,3,4]) this.roomClients.set(n, new Set());
    if (!this.rooms.size){
      for (const n of [1,2,3,4]) this.rooms.set(n, this.newRoom());
    }
  }

  // Step1: short TTL sweep for browser HB
  startShortSweep(){
    if (this.hbTimerStarted) return; this.hbTimerStarted = true;
    const TTL_HB = Number((globalThis as any).TTL_HB || 25000);
    const SWEEP_SHORT = Number((globalThis as any).SWEEP_SHORT || 10000);
    const loop = async () => {
      while(true){
        await new Promise(r=>setTimeout(r, SWEEP_SHORT));
        const now = Date.now();
        for (const [tok, ts] of Array.from(this.lastHbAt.entries())){
          if (now - ts > TTL_HB){
            const info = this.tokenMap.get(tok);
            if (info){
              slog('LEAVE_TIMEOUT_HB', { room: info.room });
              this.leaveByTokenInfo(info);
            }
            this.lastHbAt.delete(tok);
          }
        }
      }
    };
    this.state.waitUntil(loop());
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // SSE
    if (url.pathname==='/sse'){
      const roomQ = url.searchParams.get('room') || 'all';
      if (roomQ==='all') return this.handleSseLobby();
      const room = Math.max(1, Math.min(4, parseInt(roomQ,10) || 1));
      const seat = (url.searchParams.get('seat') || 'observer') as Seat;
      const sseId = url.searchParams.get('sse') || undefined;
      return this.handleSseRoom(room, seat, sseId);
    }

    // API
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
        controller.enqueue(encoder('event: room_state\ndata: '+JSON.stringify(this.snapshot(room, seat))+'\n\n'));
        if (clients.size===1) this.startPinger(clients);
        slog('SSE_ROOM_ADD', { room, seat, sseId, total: clients.size });
      },
      cancel: () => {
        slog('SSE_ROOM_CANCEL', { room, seat, total: this.roomClients.get(room)!.size });
      }
    });
    return new Response(stream, sseHeaders());
  }

  // ★ HB/Join/Leave 統合
  async handleAction(req:Request): Promise<Response> {
    const body = await req.json().catch(()=>({}));
    const action = (body.action||'').toLowerCase();
    const room = Math.max(1, Math.min(4, parseInt(body.room,10)||1));
    const wantSeat = (body.seat || 'observer') as Seat;
    const sseId = body.sse as (string|undefined);
    const r = this.rooms.get(room)!;

    // Step1: Heartbeat (browser) -- empty body or {"action":"hb"} with X-Play-Token
    if ((action==='' || action==='hb')){
      const token = req.headers.get('X-Play-Token') || '';
      if (token){
        this.lastHbAt.set(token, Date.now());
        slog('HB', { room });
        this.startShortSweep();
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    }

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

          // 両者が揃った瞬間に初期化して再開（leave からの復帰含む）
          if (r.black && r.white){
            r.board = initialBoard();
            r.status='playing';
            r.turn='black';
            r.firstMoveLoggedBlack = false;
            r.firstMoveLoggedWhite = false;
          }

          slog('JOIN', { room, seat: wantSeat, token: tokShort(token) });
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

  async handleMove(req:Request): Promise<Response> {
    // 既存の move 実装を維持（省略）
    return new Response('Not Implemented', {status:501});
  }

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
    if (info.sseId) this.sseMap.delete(info.sseId);
    if ((r.black && !r.white) || (!r.black && r.white)){
      r.status='leave'; r.turn=null; r.board = initialBoard();
    }
    if (!r.black && !r.white){
      r.status='waiting'; r.turn=null; r.board = initialBoard();
    }
    this.broadcastLobby(); this.broadcastRoom(info.room);
  }

  snapshotAll(){ /* 既存 */ }
  snapshot(room:number, seat:Seat='observer'){ /* 既存 */ }
  broadcastLobby(){ /* 既存 */ }
  broadcastRoom(room:number){ /* 既存 */ }

  // Step1: SSE ping disabled (no-op)
  startPinger(set:Set<Client>){
    // Step1: SSE ping disabled (no-op)
  }

  newRoom(){
    return {
      board: initialBoard(),
      status: 'waiting' as Status,
      turn: null as any,
      watchers: 0,
      black: undefined as (string|undefined),
      white: undefined as (string|undefined),
      firstMoveLoggedBlack: false,
      firstMoveLoggedWhite: false
    };
  }
}

export default {
  async fetch(request: Request, env: any) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  }
} satisfies ExportedHandler;