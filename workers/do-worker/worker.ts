// workers/do-worker/worker.ts -- v1.1.4
// 変更点: 1) adminReset() を追加 2) POST /api/action で "__admin_reset__" を処理して 204 を返す
// 既存の盤面 / SSE / HB 実装はそのまま。

import {
  encoder, tokShort, genToken, initialBoard,
  snapshotRoom, snapshotAll, // ← 既存の utils.ts にある前提（v1.1.2）
} from './utils';

type Seat = 'black' | 'white' | 'observer';
type Status = 'waiting' | 'black' | 'white' | 'leave' | 'finished';
type TokenInfo = { room: number; seat: Exclude<Seat, 'observer'> };

type RoomState = {
  status: Status;
  turn: 'black' | 'white' | null;
  board: { size: number; stones: string[] };
  black?: string | null;               // token
  white?: string | null;               // token
  watchers: Set<string>;               // sse id set
};

type SseSink = {
  id: string;                           // sse id
  controller: ReadableStreamDefaultController | null;
  send: (ev: string, data: unknown) => void;
  close: () => void;
};

export class ReversiHub {
  state: DurableObjectState;
  env: any;

  rooms = new Map<number, RoomState>();
  tokenMap = new Map<string, TokenInfo>();   // token -> room/seat
  lastHbAt = new Map<string, number>();      // HB を一度でも受信した token のみ記録

  // SSE
  lobbyClients = new Map<string, SseSink>(); // id -> sink
  roomClients = new Map<number, Map<string, SseSink>>(); // room -> (id -> sink)

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    for (const n of [1, 2, 3, 4]) {
      this.rooms.set(n, {
        status: 'waiting',
        turn: null,
        board: initialBoard(),
        black: null,
        white: null,
        watchers: new Set<string>(),
      });
      this.roomClients.set(n, new Map());
    }
  }

  // ---- HTTP entry ----
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ---- Lobby / Room SSE ----
    if (req.method === 'GET' && url.pathname === '/' && req.headers.get('accept')?.includes('text/event-stream')) {
      const roomQ = url.searchParams.get('room');
      const seatQ = (url.searchParams.get('seat') as Seat) || 'observer';
      const sseId = url.searchParams.get('sse') || crypto.randomUUID();

      if (roomQ === 'all') return this.handleLobbySse(sseId);
      const room = Number(roomQ || '0');
      if (room >= 1 && room <= 4) return this.handleRoomSse(room, seatQ, sseId);

      return new Response('bad room', { status: 400 });
    }

    // ---- /api/action （join/leave/hb/admin）----
    if (req.method === 'POST' && url.pathname === '/api/action') {
      // admin: Pages Functions から内部的に呼ばれる（クライアントからは /api/admin を叩くだけ）
      try {
        const bodyText = await req.text();
        if (bodyText) {
          const body = JSON.parse(bodyText);
          if (body && body.action === '__admin_reset__') {
            await this.adminReset();        // ★ 追加
            return new Response(null, { status: 204 });
          }
          // 以降は通常の join/leave/hb を従来どおり処理
          if (body.action === 'join') return this.handleJoin(body);
          if (body.action === 'leave') return this.handleLeave(body);
        }
      } catch {
        // HB はボディなし or 不正 JSON を許容する
      }
      // HB（X-Play-Token ヘッダのみ・204）
      const token = req.headers.get('X-Play-Token');
      if (token) {
        this.lastHbAt.set(token, Date.now());
        return new Response(null, { status: 204 });
      }
      return new Response('bad request', { status: 400 });
    }

    // ---- /api/move ----
    if (req.method === 'POST' && url.pathname === '/api/move') {
      return this.handleMove(req);
    }

    // その他
    return new Response('not found', { status: 404 });
  }

  // ==================== Admin Reset（v1.1.4） ====================
  /**
   * 仕様:
   *  - 4ルームすべて初期化（status=waiting / turn=null / 初期盤面）
   *  - tokenMap / lastHbAt をクリア
   *  - ロビー/ルームの SSE をすべて close（watchers は即 0 へ）
   *  - ブロードキャストはしない（SSEを切るため不要）
   *  - レスポンスは呼び出し元で 204 を返す
   */
  private async adminReset(): Promise<void> {
    // 既存 SSE をすべて close
    for (const [_, sink] of this.lobbyClients) {
      try { sink.close(); } catch {}
    }
    this.lobbyClients.clear();
    for (const n of [1, 2, 3, 4]) {
      const m = this.roomClients.get(n)!;
      for (const [_, sink] of m) { try { sink.close(); } catch {} }
      m.clear();
    }

    // ルーム状態をリセット
    for (const n of [1, 2, 3, 4]) {
      const r = this.rooms.get(n)!;
      r.status = 'waiting';
      r.turn = null;
      r.board = initialBoard();
      r.black = null;
      r.white = null;
      r.watchers.clear();
    }

    // トークン・HB を全消去
    this.tokenMap.clear();
    this.lastHbAt.clear();
  }

  // ==================== SSE ====================
  private sseStream(register: (sink: SseSink) => void): Response {
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const encoder_ = encoder();
    const sink: SseSink = {
      id: crypto.randomUUID(),
      controller: null,
      send: (ev, data) => {
        const payload = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
        writer.write(encoder_.encode(payload));
      },
      close: () => { try { writer.close(); } catch {} },
    };
    register(sink);
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    };
    return new Response(ts.readable, { headers });
  }

  private handleLobbySse(sseId: string): Response {
    return this.sseStream((sink) => {
      sink.id = sseId;
      this.lobbyClients.set(sseId, sink);
      // 初回 snapshot
      sink.send('room_state', snapshotAll(this.rooms, this.countWatchers.bind(this)));
    });
  }

  private handleRoomSse(room: number, seat: Seat, sseId: string): Response {
    return this.sseStream((sink) => {
      sink.id = sseId;
      const m = this.roomClients.get(room)!;
      m.set(sseId, sink);
      this.rooms.get(room)!.watchers.add(sseId);
      // 初回 snapshot
      sink.send('room_state', snapshotRoom(room, seat, this.rooms.get(room)!));
    });
  }

  private countWatchers(room: number): number {
    return this.rooms.get(room)!.watchers.size;
  }

  private broadcastLobby(): void {
    const data = snapshotAll(this.rooms, this.countWatchers.bind(this));
    for (const [_, sink] of this.lobbyClients) sink.send('room_state', data);
  }
  private broadcastRoom(room: number): void {
    const r = this.rooms.get(room)!;
    const m = this.roomClients.get(room)!;
    for (const [_, sink] of m) sink.send('room_state', snapshotRoom(room, 'observer', r));
  }

  // ==================== JOIN / LEAVE / MOVE ====================
  private handleJoin = async (body: any): Promise<Response> => {
    const room = Number(body.room || 0);
    const seat = (body.seat as Seat) || 'observer';
    const sseId = String(body.sse || '');

    if (!(room >= 1 && room <= 4)) return new Response('bad room', { status: 400 });
    const r = this.rooms.get(room)!;

    // 座席判定
    let granted: Seat = 'observer';
    if (seat === 'black' && !r.black) granted = 'black';
    else if (seat === 'white' && !r.white) granted = 'white';
    else granted = 'observer';

    let token = '';
    if (granted !== 'observer') {
      token = genToken();
      this.tokenMap.set(token, { room, seat: granted });
      if (granted === 'black') r.black = token;
      if (granted === 'white') r.white = token;
    }

    // 両者揃ったら開始
    if (r.black && r.white) {
      r.status = 'black';
      r.turn = 'black';
    } else {
      r.status = 'waiting';
      r.turn = null;
    }

    // 観戦カウント整合（room SSE の sseId を登録済みなら watchers が正確に出る）
    this.broadcastLobby();
    this.broadcastRoom(room);

    const snap = snapshotRoom(room, granted, r);
    const headers = token ? { 'X-Play-Token': token } : {};
    return new Response(JSON.stringify(snap), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  };

  private handleLeave = async (body: any): Promise<Response> => {
    const room = Number(body.room || 0);
    const r = this.rooms.get(room)!;
    // token or sseId で退室
    const token = body.token || null;
    const sseId = body.sse || null;

    if (token && this.tokenMap.has(token)) {
      const info = this.tokenMap.get(token)!;
      if (info.room === room) {
        if (info.seat === 'black' && r.black === token) r.black = null;
        if (info.seat === 'white' && r.white === token) r.white = null;
      }
      this.tokenMap.delete(token);
      this.lastHbAt.delete(token);
    } else if (sseId) {
      // Beacon 退室（sseId から座席を特定できない場合は席はそのまま）
      // ここでは簡略化：watchers のみ整合
      this.roomClients.get(room)!.delete(sseId);
      r.watchers.delete(sseId);
    }

    // 状態更新
    if (r.black && r.white) {
      r.status = r.turn === 'black' ? 'black' : 'white';
    } else {
      r.status = 'leave';
      r.turn = null;
      // 盤面維持（仕様通り）
    }

    this.broadcastLobby();
    this.broadcastRoom(room);
    return new Response(null, { status: 204 });
  };

  private async handleMove(req: Request): Promise<Response> {
    // 既存の実装（トークン検証→合法手→反転→ターン交代→broadcast）
    // ここは v1.1.2 と変更なし。詳細は省略（あなたの現行実装をそのままにしてください）。
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}

// DO 入口（既存）
export default {
  async fetch(request: Request, env: any) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  }
} satisfies ExportedHandler;