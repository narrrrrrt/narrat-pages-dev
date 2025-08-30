// workers/do-worker/worker.ts  (v1.1.1)
// NOTE: 既存の ReversiHub クラス構造/rooms/tokenMap/sseMap はそのまま活かしています。
//       追加点は: /api/heartbeat のルート、および lastSeen 更新 & Sログ出力。

export interface Env {
  // 既存バインド
  REVERSI_HUB: DurableObjectNamespace;
  // 既存の環境変数など（必要に応じて）
}

type Seat = "black" | "white" | "observer";
type Turn = "black" | "white" | null;
type Status = "waiting" | "black" | "white" | "leave" | "finished";

type Snapshot = {
  room: number;
  seat: Seat;
  status: Status;
  turn: Turn;
  board: { size: number; stones: string[] };
  legal: string[];
  watchers: number;
};

// セッション情報（JOIN 時に作られる想定）
type TokenInfo = {
  token: string;
  room: number;
  seat: Seat;
  sseId?: string;
  lastSeen?: number; // 追加: HB で更新
};

export class ReversiHub {
  state: DurableObjectState;
  env: Env;

  // 既存: 全体管理
  private tokenMap = new Map<string, TokenInfo>(); // token -> info
  // 他、rooms/sse など既存の構造は省略（あなたの現行実装をそのまま保持してください）

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // 既存: JOIN/MOVE/LEAVE/SSE などのメソッドはそのまま

  // --- 追加: HB ログ整形（token 先頭2文字だけ表示）
  private maskToken(t: string | undefined): string | undefined {
    if (!t) return undefined;
    if (t.length <= 2) return t;
    return `${t.slice(0,2)}******`;
  }

  // --- 追加: HB 処理本体
  private async handleHeartbeat(req: Request): Promise<Response> {
    // ヘッダからトークンを取得（ボディは不要）
    const token = req.headers.get("X-Play-Token") || undefined;

    if (token) {
      const info = this.tokenMap.get(token);
      if (info) {
        // lastSeen 更新（単調増加で上書き防止）
        const now = Date.now();
        info.lastSeen = Math.max(info.lastSeen ?? 0, now);
        this.tokenMap.set(token, info);

        // Sログ
        // 形式: {"log":"REVERSI","type":"HB","token":"ab******"}
        const masked = this.maskToken(token) ?? "";
        console.log(JSON.stringify({ log: "REVERSI", type: "HB", token: masked }));
      }
      // 見つからなくてもノイズを増やさない（200で返す）
    }

    return new Response("OK", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        // 必要なら CORS（他 API に合わせて）
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // 既存: /api/action や /api/move、SSE、静的返却などのルートと併存させる
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- 追加: /api/heartbeat
    if (request.method === "POST" && pathname === "/api/heartbeat") {
      return this.handleHeartbeat(request);
    }

    // 以下、既存のルーティングをそのまま（例）
    // if (request.method === "POST" && pathname === "/api/action") { ... }
    // if (request.method === "POST" && pathname === "/api/move") { ... }
    // if (request.method === "GET"  && SSE/静的 etc...) { ... }

    // 既存のデフォルト分岐へ
    return this.handleDefault(request);
  }

  // 既存のデフォルト処理（あなたの実装を残してください）
  private async handleDefault(request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  }
}

// 既存の default export は変更しない（class_name=ReversiHub に一致）
export default {
  async fetch(request, env) {
    const id = env.REVERSI_HUB.idFromName("global");
    const stub = env.REVERSI_HUB.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;