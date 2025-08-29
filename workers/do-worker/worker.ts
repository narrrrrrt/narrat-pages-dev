// workers/do-worker/worker.ts  -- v1.1.2 (HB/短TTL監視, leave=204, SSE ping disabled)
import { json, sseHeaders, encoder, tokShort, genToken, initialBoard } from './utils';

type Seat = 'black' | 'white' | 'observer';
type Status = 'waiting' | 'playing' | 'leave' | 'finished';
type TokenInfo = { room: number; seat: Seat; sseId?: string };
type Client = { controller: ReadableStreamDefaultController; seat: Seat; room: number; sseId?: string };

// ざっくりSログ（REVERSIタグ）
function slog(type: string, fields: Record<string, any> = {}) {
  try {
    console.log(JSON.stringify({ log: 'REVERSI', type, ...fields }));
  } catch {}
}

export class ReversiHub {
  state: DurableObjectState;
  rooms = new Map<number, any>();
  tokenMap = new Map<string, TokenInfo>();
  sseMap = new Map<string, TokenInfo>();
  lobbyClients = new Set<Client>();
  roomClients = new Map<number, Set<Client>>();

  // Step1: クライアントHB（短TTL監視）
  lastHbAt = new Map<string, number>();
  hbTimerStarted = false;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    (this as any).env = env;
    for (const n of [1, 2, 3, 4]) this.roomClients.set(n, new Set());
    if (!this.rooms.size) {
      for (const n of [1, 2, 3, 4]) this.rooms.set(n, this.newRoom());
    }
  }

  // ---- ルータ ----
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // SSE
    if (url.pathname === '/sse') {
      const roomQ = url.searchParams.get('room') || 'all';
      if (roomQ === 'all') return this.handleSseLobby();
      const room = Math.max(1, Math.min(4, parseInt(roomQ, 10) || 1));
      const seat = (url.searchParams.get('seat') || 'observer') as Seat;
      const sseId = url.searchParams.get('sse') || undefined;
      return this.handleSseRoom(room, seat, sseId);
    }

    // API
    if (url.pathname === '/action' && req.method === 'POST') return this.handleAction(req);
    if (url.pathname === '/move' && req.method === 'POST') return this.handleMove(req);
    if (url.pathname === '/admin' && req.method === 'POST') {
      for (const n of [1, 2, 3, 4]) this.rooms.set(n, this.newRoom());
      slog('ADMIN_RESET', {});
      this.broadcastLobby();
      for (const n of [1, 2, 3, 4]) this.broadcastRoom(n);
      return json({ ok: true });
    }

    return new Response('OK', { status: 200 });
  }

  // ---- SSE（ロビー）----
  handleSseLobby(): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        const client: Client = { controller, seat: 'observer', room: 0 };
        this.lobbyClients.add(client);
        controller.enqueue(encoder('event: room_state\ndata: ' + JSON.stringify(this.snapshotAll()) + '\n\n'));
        if (this.lobbyClients.size === 1) this.startPinger(this.lobbyClients); // no-op
        slog('SSE_LOBBY_ADD', { total: this.lobbyClients.size });
      },
      cancel: () => {
        slog('SSE_LOBBY_CANCEL', {});
      },
    });
    return new Response(stream, sseHeaders());
  }

  // ---- SSE（ルーム）----
  handleSseRoom(room: number, seat: Seat, sseId?: string): Response {
    const clients = this.roomClients.get(room)!;
    const stream = new ReadableStream({
      start: (controller) => {
        const c: Client = { controller, seat, room, sseId };
        clients.add(c);
        controller.enqueue(encoder('event: room_state\ndata: ' + JSON.stringify(this.snapshot(room, seat)) + '\n\n'));
        if (clients.size === 1) this.startPinger(clients); // no-op
        slog('SSE_ROOM_ADD', { room, seat, sseId, total: clients.size });
      },
      cancel: () => {
        slog('SSE_ROOM_CANCEL', { room, seat, total: this.roomClients.get(room)!.size });
      },
    });
    return new Response(stream, sseHeaders());
  }

  // ---- /action ----
  async handleAction(req: Request): Promise<Response> {
    const body = await req.json().catch(() => ({}));
    const action = (body.action || '').toLowerCase();
    const room = Math.max(1, Math.min(4, parseInt(body.room, 10) || 1));
    const wantSeat = (body.seat || 'observer') as Seat;
    const sseId = body.sse as string | undefined;
    const r = this.rooms.get(room)!;

    // HB（ブラウザ）-- 空ボディ or {"action":"hb"}：204 No Content
    if (action === '' || action === 'hb') {
      const token = req.headers.get('X-Play-Token') || '';
      if (token) {
        this.lastHbAt.set(token, Date.now());
        slog('HB', { room });
        this.startShortSweep();
      }
      return new Response(null, { status: 204 });
    }

    // JOIN
    if (action === 'join') {
      let seat: Seat = wantSeat;
      let token: string | undefined;

      if (wantSeat === 'black' || wantSeat === 'white') {
        const occ = wantSeat === 'black' ? r.black : r.white;
        if (!occ) {
          token = genToken();
          if (wantSeat === 'black') r.black = token; else r.white = token;
          this.tokenMap.set(token, { room, seat: wantSeat, sseId });
          if (sseId) this.sseMap.set(sseId, { room, seat: wantSeat });

          // 両者が揃ったら開始
          if (r.black && r.white) {
            r.board = initialBoard();
            r.status = 'playing';
            r.turn = 'black';
            r.firstMoveLoggedBlack = false;
            r.firstMoveLoggedWhite = false;
          }
          slog('JOIN', { room, seat: wantSeat, token: tokShort(token) });
        } else {
          seat = 'observer';
          slog('JOIN_TO_OBS', { room, want: wantSeat });
        }
      } else {
        seat = 'observer';
        slog('JOIN_OBS', { room });
      }

      const hdr = new Headers({ 'Content-Type': 'application/json' });
      if (token) hdr.set('X-Play-Token', token);
      this.broadcastLobby();
      this.broadcastRoom(room);
      return new Response(JSON.stringify(this.snapshot(room, seat)), { status: 200, headers: hdr });
    }

    // LEAVE -- v1.1.2：204 に統一（スナップショット返さない）
    if (action === 'leave') {
      const token = req.headers.get('X-Play-Token') || '';
      if (token) {
        const info = this.tokenMap.get(token);
        if (info) this.leaveByTokenInfo(info);
        const hdr = new Headers({ 'X-Log-Event': 'token-deleted' });
        return new Response(null, { status: 204, headers: hdr });
      } else if (sseId && this.sseMap.has(sseId)) {
        const info = this.sseMap.get(sseId)!;
        this.leaveByTokenInfo(info);
        const hdr = new Headers({ 'X-Log-Event': 'token-deleted' });
        return new Response(null, { status: 204, headers: hdr });
      } else {
        return new Response(null, { status: 204 });
      }
    }

    return new Response('Bad Request', { status: 400 });
  }

  // ---- /move ----
  async handleMove(req: Request): Promise<Response> {
    const body = await req.json().catch(() => ({}));
    const room = Math.max(1, Math.min(4, parseInt(body.room, 10) || 1));
    const pos = String(body.pos || '');
    const token = req.headers.get('X-Play-Token') || '';
    const r = this.rooms.get(room)!;

    if (!token) return json({ error: 'missing token' }, 401);
    const info = this.tokenMap.get(token);
    if (!info || info.room !== room) return json({ error: 'invalid token' }, 403);
    const seat = info.seat;
    if (seat !== 'black' && seat !== 'white') return json({ error: 'observer' }, 403);
    if (r.status !== 'playing') return json({ error: 'not playing' }, 409);
    if (r.turn !== seat) return json({ error: 'not your turn' }, 409);

    const board = r.board;
    const flips = this.findFlips(board, seat, pos);
    if (flips.length === 0) return json({ error: 'illegal move' }, 400);

    this.applyMove(board, seat, pos, flips);

    // 初手ログ
    if (seat === 'black' && !r.firstMoveLoggedBlack) { slog('MOVE_FIRST_BLACK', { room, pos }); r.firstMoveLoggedBlack = true; }
    if (seat === 'white' && !r.firstMoveLoggedWhite) { slog('MOVE_FIRST_WHITE', { room, pos }); r.firstMoveLoggedWhite = true; }

    // 手番交代
    const opp: Seat = seat === 'black' ? 'white' : 'black';
    r.turn = opp;

    const legalOpp = this.legalMoves(board, opp);
    if (legalOpp.length === 0) {
      const legalSelf = this.legalMoves(board, seat);
      if (legalSelf.length === 0) {
        r.status = 'finished';
        r.turn = null;
      } else {
        r.turn = seat; // パス
      }
    }

    this.broadcastLobby();
    this.broadcastRoom(room);
    return json(this.snapshot(room, seat), 200);
  }

  // ---- スナップショット ----
  snapshotAll() {
    const out: any[] = [];
    for (const n of [1, 2, 3, 4]) {
      const r = this.rooms.get(n)!;
      out.push({
        room: n,
        status: r.status as Status,
        black: !!r.black,
        white: !!r.white,
        watchers: this.countWatchers(n),
      });
    }
    return { rooms: out };
  }

  snapshot(room: number, seat: Seat = 'observer') {
    const r = this.rooms.get(room)!;
    const turnSeat = r.turn as Seat | null;
    const legal = turnSeat ? this.legalMoves(r.board, turnSeat) : [];
    return {
      room,
      seat,
      status: r.status as Status,
      turn: turnSeat,
      board: r.board,
      legal,
      watchers: this.countWatchers(room),
    };
  }

  // ---- ブロードキャスト ----
  broadcastLobby() {
    if (!this.lobbyClients.size) return;
    const payload = 'event: room_state\ndata: ' + JSON.stringify(this.snapshotAll()) + '\n\n';
    for (const c of Array.from(this.lobbyClients.values())) {
      try { c.controller.enqueue(encoder(payload)); } catch {}
    }
  }

  broadcastRoom(room: number) {
    const clients = this.roomClients.get(room)!;
    if (!clients || !clients.size) return;
    for (const c of Array.from(clients.values())) {
      const snap = this.snapshot(room, c.seat);
      const payload = 'event: room_state\ndata: ' + JSON.stringify(snap) + '\n\n';
      try { c.controller.enqueue(encoder(payload)); } catch {}
    }
  }

  // ---- 退室処理 ----
  leaveByTokenInfo(info: TokenInfo) {
    const r = this.rooms.get(info.room)!;
    if (info.seat === 'black' && r.black) {
      slog('LEAVE_BLACK', { room: info.room });
      this.tokenMap.delete(r.black);
      r.black = undefined;
    }
    if (info.seat === 'white' && r.white) {
      slog('LEAVE_WHITE', { room: info.room });
      this.tokenMap.delete(r.white);
      r.white = undefined;
    }
    if (info.sseId) this.sseMap.delete(info.sseId);

    if ((r.black && !r.white) || (!r.black && r.white)) {
      r.status = 'leave'; r.turn = null; r.board = initialBoard();
    }
    if (!r.black && !r.white) {
      r.status = 'waiting'; r.turn = null; r.board = initialBoard();
    }
    this.broadcastLobby();
    this.broadcastRoom(info.room);
  }

  // ---- HB短TTL監視 ----
  startShortSweep() {
    if (this.hbTimerStarted) return; this.hbTimerStarted = true;
    const TTL_HB = Number((globalThis as any).TTL_HB || 25000);
    const SWEEP_SHORT = Number((globalThis as any).SWEEP_SHORT || 10000);
    const loop = async () => {
      while (true) {
        await new Promise(r => setTimeout(r, SWEEP_SHORT));
        const now = Date.now();
        for (const [tok, ts] of Array.from(this.lastHbAt.entries())) {
          if (now - ts > TTL_HB) {
            const info = this.tokenMap.get(tok);
            if (info) {
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

  // ---- SSE Ping（Step1では廃止 / no-op）----
  startPinger(_set: Set<Client>) { /* no-op */ }

  // ---- ルーム生成 ----
  newRoom() {
    return {
      board: initialBoard(),
      status: 'waiting' as Status,
      turn: null as any,
      black: undefined as (string | undefined),
      white: undefined as (string | undefined),
      firstMoveLoggedBlack: false,
      firstMoveLoggedWhite: false,
    };
  }

  // ---- 盤面計算（合法手・反転）----
  legalMoves(board: { size: number; stones: string[] }, seat: Seat): string[] {
    if (seat !== 'black' && seat !== 'white') return [];
    const res: string[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (this.at(board, x, y) !== '-') continue;
        const flips = this.findFlipsXY(board, seat, x, y);
        if (flips.length) res.push(String.fromCharCode(97 + x) + String(y + 1));
      }
    }
    return res;
  }

  findFlips(board: { size: number; stones: string[] }, seat: Seat, pos: string): [number, number][] {
    if (!/^[a-h][1-8]$/.test(pos)) return [];
    const x = pos.charCodeAt(0) - 97;
    const y = parseInt(pos.slice(1), 10) - 1;
    return this.findFlipsXY(board, seat, x, y);
  }

  findFlipsXY(board: { size: number; stones: string[] }, seat: Seat, x: number, y: number): [number, number][] {
    if (seat !== 'black' && seat !== 'white') return [];
    if (this.at(board, x, y) !== '-') return [];
    const me = seat === 'black' ? 'B' : 'W';
    const op = seat === 'black' ? 'W' : 'B';
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]] as const;
    const flips: [number, number][][] = [];

    for (const [dx, dy] of dirs) {
      const path: [number, number][] = [];
      let cx = x + dx, cy = y + dy;
      while (cx>=0 && cx<8 && cy>=0 && cy<8) {
        const c = this.at(board, cx, cy);
        if (c === op) { path.push([cx, cy]); cx += dx; cy += dy; continue; }
        if (c === me && path.length) { flips.push(path); }
        break;
      }
    }
    return ([] as [number, number][]).concat(...flips);
  }

  applyMove(board: { size: number; stones: string[] }, seat: Seat, pos: string, flips: [number, number][]) {
    const x = pos.charCodeAt(0) - 97;
    const y = parseInt(pos.slice(1), 10) - 1;
    const me = seat === 'black' ? 'B' : 'W';
    this.set(board, x, y, me);
    for (const [fx, fy] of flips) this.set(board, fx, fy, me);
  }

  at(board: { size: number; stones: string[] }, x: number, y: number): string {
    return board.stones[y][x];
    // '-' | 'B' | 'W'
  }

  set(board: { size: number; stones: string[] }, x: number, y: number, v: 'B' | 'W' | '-') {
    const row = board.stones[y];
    board.stones[y] = row.slice(0, x) + v + row.slice(x + 1);
  }

  countWatchers(room: number): number {
    const set = this.roomClients.get(room);
    if (!set) return 0;
    let n = 0;
    for (const c of Array.from(set.values())) if (c.seat === 'observer') n++;
    return n;
  }
}

export default {
  async fetch(request: Request, env: any) {
    const id = env.REVERSI_HUB.idFromName('global');
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler;