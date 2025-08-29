// v1.1.x minimal pass-through middleware
// 目的: /reverse(.html) を含む静的ファイル配信を一切妨げない。
//       SSEや /api/* は各 Functions にそのまま渡す。

export const onRequest: PagesFunction = async (ctx) => {
  const { request, next } = ctx;
  const url = new URL(request.url);
  const path = url.pathname;
  const accept = request.headers.get("accept") || "";

  // 1) 静的アセット & HTML は必ず素通し
  const isHtml   = path.endsWith(".html") || path === "/";
  const isStatic =
    path === "/style.css" ||
    path.startsWith("/css/") ||
    path.startsWith("/js/") ||
    /\.(png|jpg|jpeg|gif|webp|svg|ico|mp3|mp4|txt|map|json)$/i.test(path);

  if (isHtml || isStatic) {
    return next();
  }

  // 2) ルームのプレティURLも必ず素通し（Clean URLsで /reverse.html -> /reverse になる対策）
  if (path === "/reverse" || path === "/reverse.html") {
    return next();
  }

  // 3) /api/* は各 Functions (action.ts / move.ts / admin 等) に渡す
  if (path.startsWith("/api/")) {
    return next();
  }

  // 4) SSE は Acceptヘッダで各ハンドラにそのまま渡す（ここで処理しない）
  if (accept.includes("text/event-stream")) {
    return next();
  }

  // 5) それ以外もデフォルトで素通し
  return next();
};