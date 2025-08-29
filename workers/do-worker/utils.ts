// workers/do-worker/utils.ts  -- v1.1.2

export function json(data: unknown, init: number | ResponseInit = 200) {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  const resInit: ResponseInit =
    typeof init === 'number' ? { status: init } : init;
  return new Response(JSON.stringify(data), { headers, ...resInit });
}

export function sseHeaders() {
  return {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  };
}

export function encoder(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ログ用にトークンの先頭2文字だけを出す（例: ab******）
export function tokShort(token: string): string {
  if (!token) return '';
  return token.slice(0, 2) + '******';
}

// 英数字8文字の短命トークン
export function genToken(len = 8): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

// 8x8 の初期盤面（中央4石）
export function initialBoard() {
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