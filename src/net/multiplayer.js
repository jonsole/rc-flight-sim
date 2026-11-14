// Multiplayer client: joins a room on the relay (server/), sends this
// aeroplane's state 15 times a second and keeps a SnapshotBuffer of everyone
// else's. Drawing them is done by view/peers.js.
import { SnapshotBuffer } from './snapshots.js';

const SEND_HZ = 15;
const r = (x, d) => Math.round(x * d) / d;

export class Multiplayer {
  constructor() {
    this.ws = null;
    this.status = 'off'; // off | connecting | on | error
    this.error = '';
    this.room = '';
    this.myId = 0;
    this.peers = new Map(); // id -> { id, name, aircraft, buf: SnapshotBuffer }
    this.sendTimer = 0;
    this.onEvent = () => {}; // (type, peer) for join/leave/info/status
    this.wantClose = false;
  }

  get connected() {
    return this.status === 'on';
  }

  /**
   * @param {string} server  e.g. wss://relay.example.workers.dev
   * @param {string} room
   * @param {string} name
   * @param {string} aircraft  registry id
   */
  connect(server, room, name, aircraft) {
    this.disconnect();
    this.room = room.toUpperCase();
    this.name = name;
    this.aircraft = aircraft;
    if (!server) {
      this.#setStatus('error', 'No multiplayer server configured.');
      return;
    }
    let url;
    try {
      url = new URL(`room/${encodeURIComponent(this.room)}`, server.endsWith('/') ? server : `${server}/`);
      url.protocol = url.protocol.replace(/^http/, 'ws');
    } catch {
      this.#setStatus('error', 'Bad server address.');
      return;
    }
    this.wantClose = false;
    this.#setStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name, aircraft }));
    ws.onmessage = (e) => this.#onMessage(e.data);
    ws.onerror = () => {
      if (ws === this.ws) this.#setStatus('error', 'Could not reach the server.');
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      for (const p of this.peers.values()) this.onEvent('leave', p);
      this.peers.clear();
      if (!this.wantClose && this.status !== 'error') this.#setStatus('error', 'Disconnected.');
      else if (this.wantClose) this.#setStatus('off');
    };
  }

  disconnect() {
    if (this.ws) {
      this.wantClose = true;
      const ws = this.ws;
      this.ws = null;
      ws.close();
      for (const p of this.peers.values()) this.onEvent('leave', p);
      this.peers.clear();
    }
    this.#setStatus('off');
  }

  /** Tell the room about a new name or aeroplane. */
  setInfo(name, aircraft) {
    this.name = name;
    this.aircraft = aircraft;
    if (this.connected) this.ws.send(JSON.stringify({ t: 'info', name, aircraft }));
  }

  #setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    this.onEvent('status');
  }

  #onMessage(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const now = performance.now() / 1000;
    switch (m.t) {
      case 'welcome':
        this.myId = m.id;
        this.#setStatus('on');
        for (const p of m.peers) this.#addPeer(p, false);
        break;
      case 'join':
        this.#addPeer(m, true);
        break;
      case 'info': {
        const p = this.peers.get(m.id);
        if (!p) break;
        p.name = m.name;
        p.aircraft = m.aircraft;
        this.onEvent('info', p);
        break;
      }
      case 'leave': {
        const p = this.peers.get(m.id);
        if (!p) break;
        this.peers.delete(m.id);
        this.onEvent('leave', p);
        break;
      }
      case 's': {
        const p = this.peers.get(m.id);
        if (p && Array.isArray(m.p) && Array.isArray(m.q)) p.buf.push(m.ts / 1000, now, m);
        break;
      }
      default:
    }
  }

  #addPeer(info, announce) {
    const p = { id: info.id, name: info.name, aircraft: info.aircraft, buf: new SnapshotBuffer() };
    this.peers.set(p.id, p);
    this.onEvent(announce ? 'join' : 'here', p);
  }

  /** Call every frame; sends this aeroplane's state at SEND_HZ. */
  update(dt, aircraft) {
    if (!this.connected) return;
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer += 1 / SEND_HZ;
    if (this.sendTimer < 0) this.sendTimer = 0;
    this.ws.send(JSON.stringify(encodeState(aircraft)));
  }
}

/** Compact flight state: pose, velocity, prop, control surfaces, damage. */
export function encodeState(ac) {
  const msg = {
    t: 's',
    ts: Math.round(performance.now()),
    p: ac.position.toArray().map((v) => r(v, 1000)),
    q: ac.orientation.toArray().map((v) => r(v, 10000)),
    v: ac.velocity.toArray().map((v) => r(v, 100)),
    rpm: Math.round(ac.rpm),
    d: ac.surfaces.filter((s) => s.controls.length).map((s) => r(s.deflection, 1000)),
    yaw: r(ac.servo.yaw, 100),
  };
  if (ac.crashed) msg.crashed = 1;
  if (ac.propBroken) msg.propBroken = 1;
  if (ac.broken.size) msg.broken = [...ac.broken];
  return msg;
}
