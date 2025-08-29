// workers/do-worker/worker.ts
// v1.0 ベースに「__admin_reset__」処理を追加した版

type Seat = 'black' | 'white' | 'observer';
type Status = 'waiting' | 'black' | 'white' | 'leave' | 'finished';
type TokenInfo = { room: number; seat: Exclude<Seat, 'observer'> };

type RoomState = {
  status: Status;
  turn: 'black' | 'white' | null;
  board: { size: number; stones: string[] };
  black?: string | null;
  white?: string | null;
  watchers: Set<string>; // SSE接続ID
};

type SseSink = {
  id: string;
  send: (ev: string, data: unknown) => void;
  close: () => void;
};

function initialBoard() {
  return {
    size: 8,
    stones: [
      '--------',
      '--------',
      '--------',
      '---WB---',
      '---BW---',
      '--------',
      '--------',
      '--------',
    ],
  };
}

function genToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class ReversiHub {
  state: DurableObjectState;
  env: any;

  rooms = new Map<number, RoomState>();
  tokenMap = new Map<string, TokenInfo>();
  lastHbAt = new Map<string, number>();

  lobbyClients = new Map<string, SseSink>();
  roomClients = new Map<number, Map<string, SseSink>>();

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
        watchers: new Set(),
      });
      this.roomClients.set(n, new Map());
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // SSE: ロビー/ルーム
    if (req.method === 'GET' && url.pathname === '/' && req.headers.get('accept')?.includes('text/event-stream')) {
      const roomQ = url.searchParams.get('room');
      const seatQ = (url.searchParams.get('seat') as Seat) || 'observer';
      const sseId = url.searchParams.get('sse') || crypto.randomUUID();

      if (roomQ === 'all') return this.handleLobbySse(sseId);
      const room = Number(roomQ || '0');
      if (room >= 1 && room <= 4) return this.handleRoomSse(room, seatQ, sseId);

      return new Response('bad room', { status: 400 });
    }

    // API: action (join/leave/hb/admin)
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const raw = await req.text().catch(() => "");
      if (raw) {
        try {
          const body = JSON.parse(raw);
          // ★ 追加: admin reset
          if (body && body.action === "__admin_reset__") {
            await this.adminReset();
            return new Response(null, { status: 204 });
          }
          if (body.action === 'join') return this.handleJoin(body);
          if (body.action === 'leave') return this.handleLeave(body);
        } catch {
          // pass
        }
      }
      // heartbeat
      const token = req.headers.get('X-Play-Token');
      if (token) {
        this.lastHbAt.set(token, Date.now());
        return new Response(null, { status: 204 });
      }
      return new Response('bad request', { status: 400 });
    }

    // API: move
    if (req.method === 'POST' && url.pathname === '/api/move') {
      return this.handleMove(req);
    }

    return new Response('not found', { status: 404 });
  }

  // ★ 追加: Reset DO
  private async adminReset(): Promise<void> {
    // SSE全切断
    for (const [, sink] of this.lobbyClients) { try { sink.close(); } catch {} }
    this.lobbyClients.clear();
    for (const [, m] of this.roomClients) {
      for (const [, sink] of m) { try { sink.close(); } catch {} }
      m.clear();
    }

    // ルーム初期化
    for (const n of [1, 2, 3, 4]) {
      const r = this.rooms.get(n)!;
      r.status = 'waiting';
      r.turn = null;
      r.board = initialBoard();
      r.black = null;
      r.white = null;
      r.watchers.clear();
    }

    // セッション情報クリア
    this.tokenMap.clear();
    this.lastHbAt.clear();
  }

  private sseStream(register: (sink: SseSink) => void): Response {
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const encoder = new TextEncoder();
    const sink: SseSink = {
      id: crypto.randomUUID(),
      send: (ev, data) => {
        const payload = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
        writer.write(encoder.encode(payload));
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
      sink.send('room_state', this.snapshotAll());
    });
  }

  private handleRoomSse(room: number, seat: Seat, sseId: string): Response {
    return this.sseStream((sink) => {
      sink.id = sseId;
      this.roomClients.get(room)!.set(sseId, sink);
      this.rooms.get(room)!.watchers.add(sseId);
      sink.send('room_state', this.snapshotRoom(room, seat));
    });
  }

  private snapshotRoom(room: number, seat: Seat) {
    const r = this.rooms.get(room)!;
    return {
      room,
      seat,
      status: r.status,
      turn: r.turn,
      board: r.board,
      legal: [],
      watchers: r.watchers.size,
    };
  }

  private snapshotAll() {
    const arr: any[] = [];
    for (const n of [1, 2, 3, 4]) {
      const r = this.rooms.get(n)!;
      arr.push({
        room: n,
        status: r.status,
        black: !!r.black,
        white: !!r.white,
        watchers: r.watchers.size,
      });
    }
    return { rooms: arr };
  }

  private handleJoin = async (body: any): Promise<Response> => {
    const room = Number(body.room || 0);
    const seat = (body.seat as Seat) || 'observer';
    const sseId = String(body.sse || '');

    if (!(room >= 1 && room <= 4)) return new Response('bad room', { status: 400 });
    const r = this.rooms.get(room)!;

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

    if (r.black && r.white) {
      r.status = 'black';
      r.turn = 'black';
    } else {
      r.status = 'waiting';
      r.turn = null;
    }

    this.broadcastLobby();
    this.broadcastRoom(room);

    const snap = this.snapshotRoom(room, granted);
    const headers = token ? { 'X-Play-Token': token } : {};
    return new Response(JSON.stringify(snap), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  };

  private handleLeave = async (body: any): Promise<Response> => {
    const room = Number(body.room || 0);
    const r = this.rooms.get(room)!;
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
      this.roomClients.get(room)!.delete(sseId);
      r.watchers.delete(sseId);
    }

    if (r.black && r.white) {
      r.status = r.turn === 'black' ? 'black' : 'white';
    } else {
      r.status = 'leave';
      r.turn = null;
    }

    this.broadcastLobby();
    this.broadcastRoom(room);
    return new Response(null, { status: 204 });
  };

  private async handleMove(req: Request): Promise<Response> {
    // ここは v1.0 のまま実装を維持してください
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private broadcastLobby(): void {
    const data = this.snapshotAll();
    for (const [, sink] of this.lobbyClients) sink.send('room_state', data);
  }
  private broadcastRoom(room: number): void {
    const r = this.rooms.get(room)!;
    const m = this.roomClients.get(room)!;
    for (const [, sink] of m) sink.send('room_state', this.snapshotRoom(room, 'observer'));
  }
}

export default {
  async fetch(request: Request, env: any) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  }
} satisfies ExportedHandler;