// workers/do-worker/worker.ts
// Reversi Durable Object (Step1: client HB + short TTL) + fixes
// 1) [FIX] JOIN後にロビー（/ ?room=all）へ seats の占有状況が正しく反映されるように集計を修正
// 2) [HB-LOG] クライアントHB受信時にサーバ側でログ出力（type:"HB"）
// 3) HBはX-Play-Tokenヘッダ付き・ボディ空のPOST /api/action を204で応答（仕様通り）

export interface Env {
  REVERSI_HUB: DurableObjectNamespace;
}

type Seat = 'black' | 'white' | 'observer';
type RoomId = number;
type Token = string;

type RoomStatus = 'waiting' | 'playing';

type Board = {
  size: number;
  stones: string[]; // 8 lines like '---WB---'
};

type SnapshotRoom = {
  room: RoomId;
  seat: Seat;
  status: RoomStatus;
  turn: 'black' | 'white' | null;
  board: Board;
  legal: string[];
  watchers: number;
  // 既存互換のため座席の空き状況も返す（ロビーではbooleanに要約）
  seats?: { black: boolean; white: boolean };
};

type SnapshotAll = {
  rooms: Record<string, {
    seats: { black: boolean; white: boolean };
    watchers: number;
    status: RoomStatus;
  }>;
  ts: number;
};

type ActionJoin = { action: 'join'; room: RoomId; seat: Seat; sse?: string };
type ActionMove = { action: 'move'; room: RoomId; pos: string };
type ActionLeave = { action: 'leave'; room: RoomId; sse?: string };
type ActionAny = ActionJoin | ActionMove | ActionLeave | { action: 'hb' };

type TokenInfo = {
  token: Token;
  room: RoomId;
  seat: Seat;
  sse?: string;
};

type SseClient = {
  id: string;
  controller: ReadableStreamDefaultController<string>;
};

const HB_TTL_MS = 25_000;
const SWEEP_SHORT_MS = 10_000;

function now() { return Date.now(); }

function initBoard(): Board {
  return {
    size: 8,
    stones: [
      '--------', '--------', '--------',
      '---WB---',
      '---BW---',
      '--------', '--------', '--------'
    ]
  };
}

export class ReversiHub {
  state: DurableObjectState;
  env: Env;

  // state
  rooms = new Map<RoomId, {
    status: RoomStatus;
    turn: 'black' | 'white' | null;
    board: Board;
    legal: string[];
    players: Map<Token, TokenInfo>;
    watchers: number;
    sseClients: Set<SseClient>;
  }>();

  tokenMap = new Map<Token, TokenInfo>();
  lastHbAt = new Map<Token, number>();        // HB受信の記録（HB対象のみ）
  lastActionAt = new Map<Token, number>();    // join/move/leave の記録（Step2向けに温存）

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // 短TTLスイープ
    this.state.blockConcurrencyWhile(async () => {
      setInterval(() => this.sweepShort(), SWEEP_SHORT_MS);
    });
  }

  // ルーム確保
  ensureRoom(roomId: RoomId) {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = {
        status: 'waiting',
        turn: null,
        board: initBoard(),
        legal: [],
        players: new Map(),
        watchers: 0,
        sseClients: new Set()
      };
      this.rooms.set(roomId, r);
    }
    return r;
  }

  // JOIN 実装
  async join(roomId: RoomId, seat: Seat, sse?: string): Promise<{ snap: SnapshotRoom; token: Token }> {
    const room = this.ensureRoom(roomId);

    const token: Token = Math.random().toString(36).slice(2, 10);
    const info: TokenInfo = { token, room: roomId, seat, sse };
    this.tokenMap.set(token, info);
    room.players.set(token, info);

    this.lastActionAt.set(token, now());

    // 対局開始の判定（黒白が揃ったら playing）
    if (this.findSeat(roomId, 'black') && this.findSeat(roomId, 'white')) {
      room.status = 'playing';
      room.turn = 'black';
    } else {
      room.status = 'waiting';
      room.turn = null;
    }

    const snap: SnapshotRoom = {
      room: roomId,
      seat,
      status: room.status,
      turn: room.turn,
      board: room.board,
      legal: room.legal,
      watchers: room.watchers,
    };

    // [FIX] JOIN直後にロビーへ正しい集計をbroadcast
    this.broadcastLobby();

    return { snap, token };
  }

  // LEAVE 実装（冪等）
  async leaveByToken(token: Token, reason: string) {
    const info = this.tokenMap.get(token);
    if (!info) return;

    const room = this.rooms.get(info.room);
    this.tokenMap.delete(token);
    this.lastHbAt.delete(token);
    this.lastActionAt.delete(token);

    if (room) {
      room.players.delete(token);

      // 座席が空になったら waiting へ
      if (!this.findSeat(info.room, 'black') || !this.findSeat(info.room, 'white')) {
        room.status = 'waiting';
        room.turn = null;
      }
    }

    // [FIX] 退室でもロビー集計を更新
    this.broadcastLobby();

    // ルーム内へも通知（必要最小限）
    this.broadcastRoom(info.room);
  }

  // 座席占有チェック
  findSeat(roomId: RoomId, seat: 'black' | 'white'): boolean {
    const room = this.ensureRoom(roomId);
    for (const p of room.players.values()) {
      if (p.seat === seat) return true;
    }
    return false;
  }

  // ロビー用スナップショット集計
  snapshotAll(): SnapshotAll {
    const out: SnapshotAll = { rooms: {}, ts: now() };
    for (let i = 1; i <= 4; i++) {
      const r = this.ensureRoom(i);
      // [FIX] players から seats をbooleanで集計
      const seats = {
        black: this.findSeat(i, 'black'),
        white: this.findSeat(i, 'white'),
      };
      out.rooms[String(i)] = {
        seats,
        watchers: r.watchers,
        status: r.status,
      };
    }
    return out;
  }

  // ルーム用スナップショット
  snapshotRoom(roomId: RoomId, seat: Seat): SnapshotRoom {
    const r = this.ensureRoom(roomId);
    return {
      room: roomId,
      seat,
      status: r.status,
      turn: r.turn,
      board: r.board,
      legal: r.legal,
      watchers: r.watchers,
    };
  }

  // SSE: ロビーへ配信
  broadcastLobby() {
    const snap = this.snapshotAll();
    // ロビーは ?room=all を購読しているクライアントへ送る設計なら、
    // ここでは全ルームのsseClientsを総当りする簡易実装
    for (const [, r] of this.rooms) {
      for (const client of r.sseClients) {
        try {
          client.controller.enqueue(`event: room_state\ndata: ${JSON.stringify(snap)}\n\n`);
        } catch { /* ignore */ }
      }
    }
  }

  // SSE: ルーム内へ配信
  broadcastRoom(roomId: RoomId) {
    const r = this.ensureRoom(roomId);
    const snap = this.snapshotRoom(roomId, 'observer');
    for (const client of r.sseClients) {
      try {
        client.controller.enqueue(`event: room_state\ndata: ${JSON.stringify(snap)}\n\n`);
      } catch { /* ignore */ }
    }
  }

  sweepShort() {
    const nowMs = now();
    const expired: Token[] = [];
    for (const [token, t] of this.lastHbAt) {
      if (nowMs - t > HB_TTL_MS) expired.push(token);
    }
    if (expired.length) {
      for (const tk of expired) {
        console.log(JSON.stringify({ log: 'REVERSI', type: 'LEAVE_TIMEOUT_HB', token: tk.slice(0, 2) + '******', at: now() }));
        this.leaveByToken(tk, 'timeout_hb');
      }
    }
  }

  // --- HTTPエンドポイント ----------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    // SSE
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      // ロビー購読 (?room=all) / ルーム購読 (?room=<n>)
      const roomParam = searchParams.get('room');
      if (!roomParam) return new Response('Bad Request', { status: 400 });

      if (roomParam === 'all') {
        // 任意のルームにぶら下げる（簡易実装）
        const r = this.ensureRoom(1);
        return this.openSse(r, true);
      } else {
        const roomId = Math.max(1, Math.min(4, parseInt(roomParam, 10) || 1));
        const r = this.ensureRoom(roomId);
        return this.openSse(r, false, roomId, searchParams.get('seat') as Seat ?? 'observer');
      }
    }

    if (pathname === '/api/action' && req.method === 'POST') {
      // HB判定：ヘッダに X-Play-Token あり & ボディ空
      const token = req.headers.get('X-Play-Token') || '';
      let raw = '';
      try { raw = await req.text(); } catch { raw = ''; }

      if (token && !raw) {
        // [HB-LOG] HB受信ログ
        console.log(JSON.stringify({ log: 'REVERSI', type: 'HB', token: token.slice(0, 2) + '******', at: now() }));
        this.lastHbAt.set(token, now());
        return new Response(null, { status: 204 });
      }

      // JSONボディ（join/move/leave）
      let body: ActionAny;
      try { body = JSON.parse(raw || '{}'); } catch { return new Response('Bad JSON', { status: 400 }); }

      if (body.action === 'join') {
        const { room, seat, sse } = body as ActionJoin;
        const { snap, token } = await this.join(room, seat, sse);
        const headers = new Headers({ 'Content-Type': 'application/json', 'X-Play-Token': token });
        return new Response(JSON.stringify(snap), { status: 200, headers });
      }

      if (body.action === 'move') {
        // 盤面更新など（簡易：今回は未改修）
        this.lastActionAt.set(token, now());
        const info = token ? this.tokenMap.get(token) : undefined;
        if (info) this.broadcastRoom(info.room);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (body.action === 'leave') {
        // sseId / token いずれでもOK（今回はtoken優先）
        if (token) await this.leaveByToken(token, 'leave');
        return new Response(null, { status: 204 });
      }

      // 明示的HB（{"action":"hb"}）にも対応
      if (body.action === 'hb' && token) {
        console.log(JSON.stringify({ log: 'REVERSI', type: 'HB', token: token.slice(0, 2) + '******', at: now() }));
        this.lastHbAt.set(token, now());
        return new Response(null, { status: 204 });
      }

      return new Response('Bad action', { status: 400 });
    }

    // テスト用管理: 全リセット（POST /api/admin）
    if (pathname === '/api/admin' && req.method === 'POST') {
      this.rooms.clear();
      this.tokenMap.clear();
      this.lastHbAt.clear();
      this.lastActionAt.clear();
      return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    return new Response('Not Found', { status: 404 });
  }

  // SSEオープン
  openSse(room: ReturnType<ReversiHub['ensureRoom']>, isLobby: boolean, roomId?: RoomId, seat?: Seat) {
    const stream = new ReadableStream<string>({
      start: (controller) => {
        const id = Math.random().toString(36).slice(2, 10);
        const client: SseClient = { id, controller };
        room.sseClients.add(client);

        controller.enqueue(`retry: 2000\n\n`);

        // 接続時に即スナップショットを1発
        if (isLobby) {
          controller.enqueue(`event: room_state\ndata: ${JSON.stringify(this.snapshotAll())}\n\n`);
        } else if (roomId != null) {
          controller.enqueue(`event: room_state\ndata: ${JSON.stringify(this.snapshotRoom(roomId, seat ?? 'observer'))}\n\n`);
        }

        // クローズ処理
        // Note: ブラウザ側は自動再接続する
        (controller as any).onCancel = () => {
          room.sseClients.delete(client);
        };
      },
      cancel: () => {
        // GC
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}

// DOエクスポート
export default {
  async fetch(req: Request, env: Env) {
    const id = env.REVERSI_HUB.idFromName('hub');
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(req);
  }
};