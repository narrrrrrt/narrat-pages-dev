// functions/api/admin.ts
// 目的: Reset DO（全ルーム初期化＆全SSE切断）をトリガーする最小API。
// 仕様: パラメータ不要 / 応答は 204 No Content（本文なし）

export const onRequestPost: PagesFunction = async ({ request }) => {
  // 同一オリジンの /api/action に "__admin_reset__" を一度だけ転送
  const actionUrl = new URL("/api/action", request.url);
  try {
    await fetch(actionUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "__admin_reset__" }),
    });
  } catch {
    // 失敗しても仕様上は本文なしで返す（UI側はリロードで整合）
  }
  return new Response(null, { status: 204 });
};