// functions/api/admin.ts
// 目的: クライアントからの POST /api/admin を既存の /api/action に転送し、
//       DO 側の admin reset を起動する。「204 No Content」を返すだけ。
// 注意: クライアントからはパラメータ不要（空リクエストでOK）。

export const onRequestPost: PagesFunction = async ({ request }) => {
  // 既存の /api/action 経由で DO に届くよう、同一オリジンへ内部呼び出し
  const actionUrl = new URL("/api/action", request.url);

  // DO 側では "__admin_reset__" を見て初期化を実行する（本文は Pages 内だけで使用）
  await fetch(actionUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "__admin_reset__" }),
    // 応答は捨てる（204想定）
  }).catch(() => { /* 無視 */ });

  // 仕様どおり本文なし
  return new Response(null, { status: 204 });
};