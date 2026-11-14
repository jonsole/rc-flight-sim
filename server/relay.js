// Multiplayer relay for the RC flight sim (plain Node + ws).
//
// A browser opens wss://<host>/room/<CODE> to join room CODE. The relay gives
// every player an id and passes each message on to the other players in the
// room. It does no simulation: every browser flies its own aeroplane and
// draws the others from the states they send. Rooms live in memory and
// vanish when empty.
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
//
// Environment: PORT (default 8787), ALLOWED_ORIGINS (comma separated pages
// that may connect; local dev servers are always allowed).

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://jonsole.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PLAYERS = 16;
const MAX_MESSAGE = 1024; // bytes; states are ~200
const MAX_RATE = 40; // messages per second per player (the sim sends 15)
const CODE_RE = /^[A-Z0-9-]{1,24}$/;

/** room code -> Set of sockets (each with .info) */
const rooms = new Map();

function allowedOrigin(origin) {
  if (!origin) return true; // non-browser clients (tests)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return ALLOWED.includes(origin);
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function broadcast(room, from, text) {
  for (const ws of room) {
    if (ws !== from && ws.info.joined && ws.readyState === ws.OPEN) ws.send(text);
  }
}

const server = http.createServer((req, res) => {
  // Health check (also wakes a sleeping free-tier instance).
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end(`rc-flight-sim relay ok, ${rooms.size} rooms\n`);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

server.on('upgrade', (req, socket, head) => {
  const m = (req.url || '').match(/^\/room\/([^/?]+)/);
  const code = m ? decodeURIComponent(m[1]).toUpperCase() : '';
  const reject = (status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!CODE_RE.test(code)) return reject(400, 'Bad Room Code');
  if (!allowedOrigin(req.headers.origin)) return reject(403, 'Origin Not Allowed');
  if ((rooms.get(code)?.size || 0) >= MAX_PLAYERS) return reject(403, 'Room Full');
  wss.handleUpgrade(req, socket, head, (ws) => join(ws, code));
});

function join(ws, code) {
  if (!rooms.has(code)) rooms.set(code, new Set());
  const room = rooms.get(code);
  room.add(ws);
  ws.info = { id: 0, joined: false, win: 0, count: 0 };
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const info = ws.info;
    const now = Date.now();
    if (now - info.win > 1000) {
      info.win = now;
      info.count = 0;
    }
    if (++info.count > MAX_RATE) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (!info.joined) {
      if (msg.t !== 'hello') return;
      info.id = Math.max(0, ...[...room].map((w) => w.info.id)) + 1;
      info.joined = true;
      info.name = clean(msg.name, 20) || `Pilot ${info.id}`;
      info.aircraft = clean(msg.aircraft, 40);
      const peers = [...room]
        .filter((w) => w !== ws && w.info.joined)
        .map((w) => ({ id: w.info.id, name: w.info.name, aircraft: w.info.aircraft }));
      ws.send(JSON.stringify({ t: 'welcome', id: info.id, peers }));
      broadcast(room, ws, JSON.stringify({ t: 'join', id: info.id, name: info.name, aircraft: info.aircraft }));
      return;
    }
    if (msg.t === 'info') {
      info.name = clean(msg.name, 20) || info.name;
      info.aircraft = clean(msg.aircraft, 40) || info.aircraft;
      broadcast(room, ws, JSON.stringify({ t: 'info', id: info.id, name: info.name, aircraft: info.aircraft }));
    } else if (msg.t === 's') {
      msg.id = info.id;
      broadcast(room, ws, JSON.stringify(msg));
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    if (ws.info.joined) broadcast(room, ws, JSON.stringify({ t: 'leave', id: ws.info.id }));
    if (!room.size) rooms.delete(code);
  });
  ws.on('error', () => ws.terminate());
}

// Ping every 25 s: drops dead connections and keeps proxies from idling us out.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000).unref();

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
