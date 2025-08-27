// functions/_middleware.ts
// Logs policy: console logs only on first move and when token is deleted.
// R2 long-term logging for HTML/text is left to implementation per specs.

export const onRequest: PagesFunction = async (context) => {
  const { request, next } = context;
  // pass to route handler
  const res = await next();

  // Look for route handlers signaling a log event via response headers
  const logEvent = res.headers.get("X-Log-Event");
  if (logEvent === "first-move") {
    const seat = res.headers.get("X-Seat") ?? "";
    const room = res.headers.get("X-Room") ?? "";
    const token = res.headers.get("X-Token") ?? "";
    console.log(JSON.stringify({ event: "first_move", seat, room, token }));
  } else if (logEvent === "token-deleted") {
    const token = res.headers.get("X-Token") ?? "";
    console.log(JSON.stringify({ event: "token_deleted", token }));
  }

  // (Optional) R2 logging for HTML/text responses can be implemented here.

  return res;
};
