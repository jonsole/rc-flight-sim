// Multiplayer relay for the RC flight sim.
//
// GET /room/<CODE> (WebSocket upgrade) joins room CODE. Each room is one
// Durable Object; it gives every player an id and passes each message on to
// the other players in the room. It does no simulation: every browser flies
// its own aeroplane and draws the others from the states they send.
//
// Protocol (JSON text frames):
//   client -> server
//     { t: 'hello', name, aircraft }       first message, required
//     { t: 's', ... }                      flight state, relayed as-is plus `id`
//     { t: 'info', name, aircraft }        changed name or aeroplane
//   server -> client
//     { t: 'welcome', id, peers: [{ id, name, aircraft }] }
//     { t: 'join', id, name, aircraft }
//     { t: 'info', id, name, aircraft }
//     { t: 'leave', id }
//     { t: 's', id, ... }
//     { t: 'error', message }

const MAX_PLAYERS = 16;
const MAX_MESSAGE = 1024; // bytes; states are ~200
const MAX_RATE = 40; // messages per second per player (sim sends 15)
const CODE_RE = /^[A-Z0-9-]{1,24}$/;

function allowedOrigin(origin, env) {
  if (!origin) return true; // non-browser clients (tests)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('rc-flight-sim relay ok\n', { headers: { 'content-type': 'text/plain' } });
    }
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('Not found', { status: 404 });
    const code = decodeURIComponent(m[1]).toUpperCase();
    if (!CODE_RE.test(code)) return new Response('Bad room code', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    if (!allowedOrigin(request.headers.get('Origin'), env)) return new Response('Origin not allowed', { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(request);
  },
};

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** Players currently in the room: [{ ws, info }] (survives hibernation). */
  players() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, info: ws.deserializeAttachment() || {} }));
  }

  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response('Room full', { status: 403 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernatable: the object can sleep between messages without dropping sockets.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: 0, joined: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(from, text) {
    for (const { ws, info } of this.players()) {
      if (ws === from || !info.joined) continue;
      try {
        ws.send(text);
      } catch {
        /* closing */
      }
    }
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    const info = ws.deserializeAttachment() || {};
    // Rate limit (per second window).
    const now = Date.now();
    if (now - (info.win || 0) > 1000) {
      info.win = now;
      info.count = 0;
    }
    if (++info.count > MAX_RATE) {
      ws.serializeAttachment(info);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (!info.joined) {
      if (msg.t !== 'hello') return;
      const ids = this.players().map((p) => p.info.id || 0);
      info.id = Math.max(0, ...ids) + 1;
      info.joined = true;
      info.name = clean(msg.name, 20) || `Pilot ${info.id}`;
      info.aircraft = clean(msg.aircraft, 40);
      ws.serializeAttachment(info);
      const peers = this.players()
        .filter((p) => p.ws !== ws && p.info.joined)
        .map((p) => ({ id: p.info.id, name: p.info.name, aircraft: p.info.aircraft }));
      ws.send(JSON.stringify({ t: 'welcome', id: info.id, peers }));
      this.broadcast(ws, JSON.stringify({ t: 'join', id: info.id, name: info.name, aircraft: info.aircraft }));
      return;
    }

    if (msg.t === 'info') {
      info.name = clean(msg.name, 20) || info.name;
      info.aircraft = clean(msg.aircraft, 40) || info.aircraft;
      ws.serializeAttachment(info);
      this.broadcast(ws, JSON.stringify({ t: 'info', id: info.id, name: info.name, aircraft: info.aircraft }));
      return;
    }
    ws.serializeAttachment(info);
    if (msg.t === 's') {
      msg.id = info.id;
      this.broadcast(ws, JSON.stringify(msg));
    }
  }

  async webSocketClose(ws) {
    this.left(ws);
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const info = ws.deserializeAttachment() || {};
    try {
      ws.close(1000, 'bye');
    } catch {
      /* already closed */
    }
    if (info.joined) this.broadcast(ws, JSON.stringify({ t: 'leave', id: info.id }));
  }
}
