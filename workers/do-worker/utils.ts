// workers/do-worker/utils.ts
// 既存のエクスポート（encoder / tokShort / genToken / initialBoard）は据え置き。
// 今回、ビルドエラー解消のため snapshotRoom / snapshotAll を追加。

// --- 既存 ---
export function encoder(): TextEncoder {
  return new TextEncoder();
}

export function tokShort(token: string): string {
  return token ? `${String(token).slice(0, 2)}******` : '';
}

export function genToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function initialBoard(): { size: number; stones: string[] } {
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

// --- 追加（ここから）---
/**
 * ルーム用スナップショット
 * - legal は既存状態に入っていればそれを使い、無ければ空配列。
 * - watchers は Set の size を優先、数値があればそれを採用。
 */
export function snapshotRoom(
  room: number,
  seat: 'black' | 'white' | 'observer',
  r: any
): {
  room: number;
  seat: 'black' | 'white' | 'observer';
  status: string;
  turn: 'black' | 'white' | null;
  board: { size: number; stones: string[] };
  legal: string[];
  watchers: number;
} {
  const watchers =
    r?.watchers && typeof r.watchers.size === 'number'
      ? r.watchers.size
      : typeof r?.watchers === 'number'
      ? r.watchers
      : 0;

  return {
    room,
    seat,
    status: r?.status ?? 'waiting',
    turn: r?.turn ?? null,
    board: r?.board ?? initialBoard(),
    legal: Array.isArray(r?.legal) ? r.legal : [],
    watchers,
  };
}

/**
 * ロビー用スナップショット
 * - countWatchers が渡されればそれを使用。無ければ roomState.watchers から推定。
 */
export function snapshotAll(
  rooms: Map<number, any> | { [k: number]: any },
  countWatchers?: (room: number) => number
): {
  rooms: Array<{
    room: number;
    status: string;
    black: boolean;
    white: boolean;
    watchers: number;
  }>;
} {
  const get = (n: number) =>
    (rooms as any).get ? (rooms as Map<number, any>).get(n) : (rooms as any)[n];

  const list: any[] = [];
  for (const n of [1, 2, 3, 4]) {
    const r: any = get(n);
    if (!r) continue;

    const watchers =
      typeof countWatchers === 'function'
        ? countWatchers(n)
        : r?.watchers && typeof r.watchers.size === 'number'
        ? r.watchers.size
        : typeof r?.watchers === 'number'
        ? r.watchers
        : 0;

    list.push({
      room: n,
      status: r?.status ?? 'waiting',
      black: !!r?.black,
      white: !!r?.white,
      watchers,
    });
  }
  return { rooms: list };
}
// --- 追加（ここまで）---