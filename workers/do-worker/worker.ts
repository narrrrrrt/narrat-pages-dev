// workers/do-worker/index.ts
export class ReversiHub {
  state: DurableObjectState;
  env: any;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/health")) {
      return new Response("ok", { status: 200 });
    }
    // Placeholder: implement log buffering / R2 writes here if desired.
    return new Response(JSON.stringify({ ok:true, note:"ReversiHub DO placeholder" }), {
      headers: { "content-type":"application/json" }
    });
  }
}

// DO bindings entry point
export default {
  fetch(request: Request, env: any) {
    return env.REVERSI_HUB.fetch(request);
  }
} as ExportedHandler;
