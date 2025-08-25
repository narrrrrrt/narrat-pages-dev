export interface Env {
  REVERSI_HUB: DurableObjectNamespace;
}

type Lang = 'en'|'de'|'it'|'fr'|'es'|'ja';
const SUP_LANGS: Lang[] = ['en','de','it','fr','es','ja'];

// ---- I18N（外部JSONを取得。失敗時はデフォルト英語にフォールバック） ----
type I18nMap = {
  vacant?: Record<Lang,string>;
  opponent_left: Record<Lang,string>;
};

// 最低限のデフォルト（フェールセーフ）
const DEFAULT_I18N: I18nMap = {
  opponent_left: {
    en: "Your opponent has left.",
    de: "Ihr Gegner hat den Raum verlassen.",
    it: "Il tuo avversario ha lasciato.",
    fr: "Votre adversaire a quitté la partie.",
    es: "Tu oponente ha salido.",
    ja: "対戦相手が退室しました。"
  }
};

const I18N_TTL_MS = 5 * 60 * 1000; // 5分キャッシュ
const PING_INTERVAL_MS = 5000;     // 5秒間隔
const PING_FAIL_THRESHOLD = 3;     // 3回連続失敗で退室確定
const ROOMS = [1,2,3,4] as const;

type Side = 'black' | 'white' | 'observer';

type Connection = {
  side: Side;
  session: string;
  lang: Lang;
  writer: WritableStreamDefaultWriter;
  pingFails: number;
  closed: boolean;
};

type RoomState = {
  black: string|null; // session
  white: string|null;
  observers: number;
};

type Game = {
  room: number;
  board: number[][]; // 0 empty, 1 black, 2 white
  turn: Side;        // 'black' | 'white'
  phase: 'WaitingWhite'|'Running'|'Ended';
  match_token?: string; // 16 hex
  turn_nonce: string;
  lastMoveSession?: string; // duplicate detection per turn
};

export default {
  async fetch(request: Request, env: Env) {
    // Single instance forwarder
    const id = env.REVERSI_HUB.idFromName('hub');
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  }
}

export class ReversiHub {
  state: DurableObjectState;
  storage: DurableObjectStorage;
  env: Env;

  rooms: Map<number, RoomState> = new Map();
  games: Map<number, Game> = new Map();
  conns: Map<number, Set<Connection>> = new Map();

  // i18n / assets host
  assetsHost?: string;
  i18nCache?: I18nMap;
  i18nLoadedAt?: number;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;

    for (const r of ROOMS) {
      this.rooms.set(r, { black:null, white:null, observers:0 });
      this.games.set(r, makeFreshGame(r));
      this.conns.set(r, new Set());
    }

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.storage.get<any>('snapshot');
      if (stored && stored.rooms && stored.games) {
        this.rooms = new Map(stored.rooms);
        this.games = new Map((stored.games as Array<[number,Game]>).map(([k,g]) => [k,g]));
      }
    });

    this.loopPing();
  }

  loopPing() {
    const tick = async () => {
      for (const r of ROOMS) {
        for (const conn of this.conns.get(r)!) {
          if (conn.closed) continue;
          try {
            await conn.writer.write(encodeComment(`ping ${Date.now()}`));
            conn.pingFails = 0;
          } catch {
            conn.pingFails++;
            if (conn.pingFails >= PING_FAIL_THRESHOLD) {
              await this.forceLeave(r, conn.session, conn.side);
              conn.closed = true;
              try { await conn.writer.close(); } catch {}
            }
          }
        }
      }
      this.state.waitUntil(this.storage.put('snapshot', {
        rooms: Array.from(this.rooms.entries()),
        games: Array.from(this.games.entries())
      }));
      setTimeout(tick, PING_INTERVAL_MS);
    };
    setTimeout(tick, PING_INTERVAL_MS);
  }

  // ---- I18N 読み込み ----
  async loadI18n(): Promise<I18nMap> {
    const now = Date.now();
    if (this.i18nCache && this.i18nLoadedAt && (now - this.i18nLoadedAt < I18N_TTL_MS)) {
      return this.i18nCache;
    }
    // assetsHost が無いときはデフォルト
    if (!this.assetsHost) {
      this.i18nCache = DEFAULT_I18N;
      this.i18nLoadedAt = now;
      return this.i18nCache;
    }
    try {
      const url = `https://${this.assetsHost}/i18n/system-messages.json`;
      const resp = await fetch(url, { // same-origin Pages をHTTP経由で読む
        cf: { cacheTtl: 300, cacheEverything: true } as any
      });
      if (resp.ok) {
        const data = await resp.json<I18nMap>();
        // 最低限キーがあるか確認
        if (data && data.opponent_left && data.opponent_left.en) {
          this.i18nCache = data;
          this.i18nLoadedAt = now;
          return data;
        }
      }
    } catch (_e) {
      // ignore
    }
    this.i18nCache = DEFAULT_I18N;
    this.i18nLoadedAt = now;
    return this.i18nCache;
  }

  // ---- Router ----
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Functions から Host を受けて保持（以後の外部JSON取得に使用）
    const xHost = request.headers.get('X-Host');
    if (xHost) this.assetsHost = xHost;

    if (path.endsWith('/lobby/state') && request.method === 'POST') {
      return this.lobbyState();
    }
    if (path.endsWith('/lobby/seat') && request.method === 'POST') {
      const body = await request.json();
      return this.lobbySeat(body);
    }
    if (path.endsWith('/lobby/reset') && request.method === 'POST') {
      return this.resetAll();
    }
    if (path.endsWith('/lobby/events') && request.method === 'GET') {
      return this.lobbyEvents();
    }
    if (path.endsWith('/room/seat') && request.method === 'POST') {
      const body = await request.json();
      return this.roomSeat(body);
    }
    if (path.match(/\/room\/\d+\/move$/) && request.method === 'POST') {
      const room = Number(path.split('/')[2]);
      const body = await request.json();
      return this.roomMove(room, body);
    }
    if (path.endsWith('/room/leave') && request.method === 'POST') {
      const body = await request.json();
      return this.roomLeave(body);
    }
    if (path.endsWith('/room/events') && request.method === 'GET') {
      return this.roomEvents(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // ---- Lobby ----
  async lobbyState(): Promise<Response> {
    const payload = { rooms: Object.fromEntries(ROOMS.map(r => [r, this.roomView(r)])) };
    return json(payload);
  }

  roomView(room: number): RoomState {
    const rs = this.rooms.get(room)!;
    return {
      black: rs.black ? '●' : null,
      white: rs.white ? '○' : null,
      observers: (this.conns.get(room)?.size || 0)
    };
  }

  async lobbySeat(body: any): Promise<Response> {
    const room = clampRoom(body.room);
    const side: Side = body.side || 'observer';
    const session: string = body.session || '';
    if (!room || !session) return json({ error: 'bad_request' }, 400);

    const forced = this.enforceSeat(room, side, session);

    // ゲーム開始（黒白揃った瞬間）
    const rs = this.rooms.get(room)!;
    if (rs.black && rs.white) {
      const g = this.games.get(room)!;
      if (!g.match_token) {
        g.match_token = genMatchToken();
        console.log(`game_started room=${room} match_token=${g.match_token}`);
      }
      if (g.phase !== 'Running') {
        this.games.set(room, startGame(room, g.match_token));
        await this.broadcastSnapshot(room);
      }
    }

    await this.broadcastLobbyUpdate(room);
    return json({ ok: true, room, side: forced });
  }

  enforceSeat(room: number, side: Side, session: string): Side {
    const rs = this.rooms.get(room)!;
    if (side === 'black') {
      if (!rs.black) rs.black = session; else return 'observer';
    } else if (side === 'white') {
      if (!rs.white) rs.white = session; else return 'observer';
    } else {
      // observerは予約なし
    }
    return side;
  }

  async resetAll(): Promise<Response> {
    for (const r of ROOMS) {
      this.rooms.set(r, { black:null, white:null, observers:0 });
      this.games.set(r, makeFreshGame(r));
      this.conns.get(r)!.forEach(c => { try{ c.writer.close(); }catch{} });
      this.conns.set(r, new Set());
      await this.broadcastLobbyUpdate(r);
    }
    await this.storage.delete('snapshot');
    return json({ ok: true });
  }

  async lobbyEvents(): Promise<Response> {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const payload = { rooms: Object.fromEntries(ROOMS.map(r => [r, this.roomView(r)])) };
    await writer.write(encodeEvent('lobby_snapshot', payload));
    this.state.waitUntil(writer.closed.catch(()=>{}));
    return new Response(readable, sseHeaders());
  }

  async broadcastLobbyUpdate(_room: number) {
    // ロビーSSEの購読者を個別管理していない最小実装。必要なら保持＆配信に拡張。
  }

  // ---- Room ----
  async roomSeat(body: any): Promise<Response> {
    return this.lobbySeat(body);
  }

  async roomLeave(body: any): Promise<Response> {
    const room = clampRoom(body.room);
    const session: string = body.session || '';
    const side: Side = body.side || 'observer';
    if (!room || !session) return json({ error: 'bad_request' }, 400);
    await this.forceLeave(room, session, side);
    return json({ ok: true });
  }

  async forceLeave(room: number, session: string, side: Side) {
    const rs = this.rooms.get(room)!;
    let changed = false;
    if (side === 'black' && rs.black === session) { rs.black = null; changed = true; }
    if (side === 'white' && rs.white === session) { rs.white = null; changed = true; }

    // セッションのSSEを閉じる
    for (const c of Array.from(this.conns.get(room)!)) {
      if (c.session === session) {
        c.closed = true;
        try { await c.writer.close(); } catch {}
        this.conns.get(room)!.delete(c);
      }
    }

    if (changed) {
      // 残留側へ i18n で通知し、盤をクリア
      const g = this.games.get(room)!;
      g.phase = 'Ended';
      g.board = emptyBoard();
      g.turn = 'black';
      g.turn_nonce = genNonce();

      const i18n = await this.loadI18n();
      for (const c of this.conns.get(room)!) {
        const msg = (i18n.opponent_left as any)[c.lang] || i18n.opponent_left.en;
        await safeWrite(c, encodeEvent('opponent_left', { message: msg, board: g.board, phase: g.phase }));
      }
    }
  }

  async roomEvents(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = clampRoom(Number(url.searchParams.get('room') || '0'));
    const side = (url.searchParams.get('side') || 'observer') as Side;
    const session = url.searchParams.get('session') || '';
    const lang = pickLang(url.searchParams.get('lang') || '');
    if (!room) return json({ error:'bad_room' }, 400);

    // Functions から受けた X-Host を保持（この時点で assetsHost が確定する想定）
    const xHost = request.headers.get('X-Host');
    if (xHost) this.assetsHost = xHost;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const conn: Connection = { side, session, lang, writer, pingFails: 0, closed: false };
    this.conns.get(room)!.add(conn);

    await this.sendSnapshot(room, conn);

    this.state.waitUntil((async () => {
      try { await writer.closed; } catch {}
      conn.closed = true;
      this.conns.get(room)!.delete(conn);
    })());

    return new Response(readable, sseHeaders());
  }

  async sendSnapshot(room: number, conn: Connection) {
    const g = this.games.get(room)!;
    const legal = (conn.side === g.turn) ? computeLegal(g.board, g.turn) : [];
    await safeWrite(conn, encodeEvent('snapshot', {
      room, board: g.board, turn: g.turn, legal, turn_nonce: g.turn_nonce, phase: g.phase
    }));
  }

  async broadcastSnapshot(room: number) {
    const g = this.games.get(room)!;
    for (const c of this.conns.get(room)!) {
      const legal = (c.side === g.turn) ? computeLegal(g.board, g.turn) : [];
      await safeWrite(c, encodeEvent('snapshot', {
        room, board: g.board, turn: g.turn, legal, turn_nonce: g.turn_nonce, phase: g.phase
      }));
    }
  }

  async roomMove(room: number, body: any): Promise<Response> {
    const g = this.games.get(room)!;
    const rs = this.rooms.get(room)!;
    const { session, coord, turn_nonce } = body as { session: string; coord: string; turn_nonce?: string };

    const moverSide: Side = (rs.black === session) ? 'black' : (rs.white === session ? 'white' : 'observer');
    if (moverSide !== g.turn) return json({ ok: false });

    if (g.lastMoveSession && g.lastMoveSession === session) {
      console.log(`move_duplicate room=${room} turn=${g.turn} coord=${coord} session=${session}`);
      return json({ ok: false, duplicate: true });
    }
    if (g.turn_nonce && turn_nonce && g.turn_nonce !== turn_nonce) {
      console.log(`move_duplicate room=${room} turn=${g.turn} nonce_mismatch session=${session}`);
      return json({ ok: false, duplicate: true });
    }

    const move = coordToRC(coord);
    if (!move) return json({ ok: false });

    const apply = applyMove(g.board, g.turn, move[0], move[1]);
    if (!apply.ok) return json({ ok: false });

    g.board = apply.board;
    g.lastMoveSession = session;

    g.turn = (g.turn === 'black' ? 'white' : 'black');
    let legal = computeLegal(g.board, g.turn);

    if (legal.length === 0) {
      g.turn = (g.turn === 'black' ? 'white' : 'black');
      legal = computeLegal(g.board, g.turn);
    }

    g.turn_nonce = genNonce();

    for (const c of this.conns.get(room)!) {
      const l = (c.side === g.turn) ? legal : [];
      await safeWrite(c, encodeEvent('move_applied', { room, board: g.board, turn: g.turn, legal: l, turn_nonce: g.turn_nonce }));
    }
    return json({ ok: true });
  }
}

// ---- helpers ----
function sseHeaders() {
  return {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  };
}
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function encodeEvent(event: string, data: any): Uint8Array {
  const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(s);
}
function encodeComment(comment: string): Uint8Array {
  const s = `: ${comment}\n\n`;
  return new TextEncoder().encode(s);
}
function pickLang(input: string): Lang {
  const low = (input || '').toLowerCase();
  for (const l of SUP_LANGS) if (low.startsWith(l)) return l;
  return 'en';
}
function clampRoom(n: any): number {
  const v = Number(n);
  return ROOMS.includes(v as any) ? v : 0;
}
function genMatchToken(): string {
  const x = Math.floor(Math.random() * 0xffffffff);
  const y = Math.floor(Math.random() * 0xffffffff);
  return (x>>>0).toString(16).padStart(8,'0') + (y>>>0).toString(16).padStart(8,'0');
}
function genNonce(): string {
  return Math.random().toString(16).slice(2,10);
}
function emptyBoard(): number[][] { return Array.from({length:8},()=>Array(8).fill(0)); }
function startBoard(): number[][] {
  const b = emptyBoard();
  b[3][3] = 2; b[3][4] = 1;
  b[4][3] = 1; b[4][4] = 2;
  return b;
}
function makeFreshGame(room: number): Game {
  return { room, board: startBoard(), turn: 'black', phase: 'WaitingWhite', turn_nonce: genNonce() };
}
function startGame(room: number, match_token?: string): Game {
  return { room, board: startBoard(), turn: 'black', phase: 'Running', match_token, turn_nonce: genNonce() };
}
function coordToRC(coord: string): [number,number]|null {
  if (!coord || coord.length < 2) return null;
  const col = coord.charAt(0).toUpperCase();
  const row = parseInt(coord.slice(1),10);
  const c = 'ABCDEFGH'.indexOf(col);
  const r = row - 1;
  if (c<0 || c>7 || r<0 || r>7) return null;
  return [r,c];
}
function within(r:number,c:number){ return r>=0&&r<8&&c>=0&&c<8; }
function diskFor(side: Side): number { return side === 'black' ? 1 : 2; }
function opp(side: Side): Side { return side==='black'?'white':'black'; }
function computeLegal(board: number[][], side: Side): [number,number][] {
  const me = diskFor(side), op = diskFor(opp(side));
  const res: [number,number][] = [];
  for (let r=0;r<8;r++){
    for (let c=0;c<8;c++){
      if (board[r][c] !== 0) continue;
      if (wouldFlip(board, r, c, me, op)) res.push([r,c]);
    }
  }
  return res;
}
function wouldFlip(board: number[][], r:number, c:number, me:number, op:number): boolean {
  const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  for (const [dr,dc] of dirs) {
    let i=r+dr, j=c+dc, seen=false;
    while (within(i,j) && board[i][j]===op) { i+=dr; j+=dc; seen=true; }
    if (seen && within(i,j) && board[i][j]===me) return true;
  }
  return false;
}
function applyMove(board: number[][], side: Side, r:number, c:number): { ok: boolean, board: number[][] } {
  const me = diskFor(side), op = diskFor(opp(side));
  if (board[r][c] !== 0) return { ok:false, board };
  const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  let flipped = 0;
  const nb = board.map(row => row.slice());
  for (const [dr,dc] of dirs) {
    let i=r+dr, j=c+dc;
    const path: [number,number][] = [];
    while (within(i,j) && nb[i][j]===op) { path.push([i,j]); i+=dr; j+=dc; }
    if (path.length && within(i,j) && nb[i][j]===me) {
      for (const [pi,pj] of path) { nb[pi][pj] = me; flipped++; }
    }
  }
  if (flipped===0) return { ok:false, board };
  nb[r][c] = me;
  return { ok:true, board: nb };
}
async function safeWrite(conn: Connection, chunk: Uint8Array) {
  if (conn.closed) return;
  try { await conn.writer.write(chunk); conn.pingFails = 0; } catch { conn.pingFails++; }
}