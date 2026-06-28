import {
  createRoom,
  applyIntent,
  applyClockTimeout,
  joinParticipant,
  preserveDisconnected,
  removeParticipant,
} from './game-engine.js';

const PROTOCOL_VERSION = 2;
// Grace before a dropped socket is treated as disconnected (greys the name).
// Generous so a quick app-switch (e.g. checking a message) isn't flagged.
const PRESENCE_GRACE_MS = 10000;
// Slack before declaring a clock timeout, to absorb in-flight moves / latency.
const CLOCK_LATENCY_GRACE_MS = 800;

const DEFAULT_BASE_SECONDS = 300;
const DEFAULT_INCREMENT_SECONDS = 3;

function parseSettings(raw) {
  const base = Number(raw && raw.baseSeconds);
  const inc = Number(raw && raw.incrementSeconds);
  return {
    baseSeconds: Number.isFinite(base) && base > 0 ? base : DEFAULT_BASE_SECONDS,
    incrementSeconds: Number.isFinite(inc) && inc >= 0 ? inc : DEFAULT_INCREMENT_SECONDS,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname !== '/ws-peer') {
      return new Response('Not found', { status: 404 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const room = String(url.searchParams.get('room') || '').trim();
    if (!room) {
      return new Response('Missing room parameter', { status: 400 });
    }

    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

// The Durable Object is now the authoritative game server (Phase C.2). It owns
// the room state, applies client intents through the shared game-core engine,
// runs the clock deadline, and broadcasts the full state. "host" is just an
// admin role (settings); seating / readiness / moves are each player's own.
export class RoomRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.loaded = false;
    this.model = null;
    this.roomName = '';

    // Infra-level keepalive: the client pings, we auto-reply pong. Used only for
    // each client to self-heal its own socket; peer presence is decided here.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  // ---- model (durable) ---------------------------------------------------
  // game:          authoritative room state (null until first hello creates it)
  // members:       { [token]: { name, joinSeq } }   connected OR within grace
  // hostToken:     string (elected; mirrored into game.hostPeerId as admin)
  // seqCounter:    number
  // pendingDrop:   { [token]: deadlineMs }          sockets gone, awaiting grace
  // clockArmed:    bool        the active player's clock is running
  // clockDeadlineAt:ms         absolute time the running clock times out

  async ensureLoaded() {
    if (this.loaded) return;
    const stored = await this.state.storage.get([
      'game',
      'members',
      'hostToken',
      'seqCounter',
      'pendingDrop',
      'clockArmed',
      'clockDeadlineAt',
      'roomName',
    ]);
    this.model = {
      game: stored.get('game') || null,
      members: stored.get('members') || {},
      hostToken: stored.get('hostToken') || '',
      seqCounter: stored.get('seqCounter') || 0,
      pendingDrop: stored.get('pendingDrop') || {},
      clockArmed: stored.get('clockArmed') || false,
      clockDeadlineAt: stored.get('clockDeadlineAt') || 0,
      roomName: stored.get('roomName') || this.roomName || '',
    };
    this.loaded = true;
  }

  async persist(keys) {
    const entries = {};
    for (const key of keys) entries[key] = this.model[key];
    await this.state.storage.put(entries);
  }

  // ---- websocket lifecycle ----------------------------------------------

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const room = String(new URL(request.url).searchParams.get('room') || '').trim();
    if (room) this.roomName = room;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ token: '' });
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawData) {
    if (rawData === 'ping' || rawData === 'pong') return;
    if (typeof rawData !== 'string') return;

    let message;
    try {
      message = JSON.parse(rawData);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    await this.ensureLoaded();

    if (message.type === 'hello') {
      await this.handleHello(socket, message);
      return;
    }

    const meta = socket.deserializeAttachment() || {};
    if (!meta.token) return;

    if (message.type === 'intent') {
      await this.handleIntent(meta.token, message);
      return;
    }

    if (message.type === 'bye') {
      await this.handleBye(socket, meta.token);
    }
  }

  async webSocketClose(socket) {
    await this.ensureLoaded();
    await this.handleSocketGone(socket);
  }

  async webSocketError(socket) {
    await this.ensureLoaded();
    await this.handleSocketGone(socket);
  }

  async alarm() {
    await this.ensureLoaded();
    const now = Date.now();
    let rosterChanged = false;
    let gameChanged = false;
    const presence = [];

    for (const [token, deadline] of Object.entries(this.model.pendingDrop)) {
      if (deadline > now) continue;
      delete this.model.pendingDrop[token];
      if (this.model.members[token]) {
        delete this.model.members[token];
        rosterChanged = true;
      }
      const departed = this.finalizeDeparture(token, now);
      if (departed) { gameChanged = true; presence.push(...departed); }
      // Host stays put during play; a non-game host drop hands off now.
      if (this.model.hostToken === token && !this.isGamePlaying()) {
        this.electHost();
        rosterChanged = true;
      }
    }

    if (rosterChanged) this.syncHostIntoGame();

    // Clock timeout: armed, the game is still live, and past the deadline.
    let timedOut = false;
    if (this.model.clockArmed && this.model.game
        && this.model.game.status === 'playing'
        && now >= this.model.clockDeadlineAt) {
      const result = applyClockTimeout(this.model.game, { now });
      if (result.applied) {
        this.applyClockEffect(result.effects.clock, now);
        gameChanged = true;
        timedOut = true;
        // The game just ended; if the host is gone, hand off now.
        if (!this.isHostConnected()) {
          this.electHost();
          this.syncHostIntoGame();
          rosterChanged = true;
        }
      }
    }

    await this.persist(['pendingDrop', 'members', 'hostToken', 'game', 'clockArmed', 'clockDeadlineAt']);
    await this.rescheduleAlarm();
    if (gameChanged || timedOut) this.broadcastGameState(null, presence.length ? { presence } : undefined);
    if (rosterChanged) this.broadcastRoster(null);
  }

  // ---- handlers ----------------------------------------------------------

  async handleHello(socket, message) {
    if (Number(message.protocol) !== PROTOCOL_VERSION) {
      this.send(socket, { type: 'protocol-mismatch', server: PROTOCOL_VERSION });
      return;
    }

    const token = String(message.token || '').trim();
    if (!token) {
      this.send(socket, { type: 'protocol-mismatch', server: PROTOCOL_VERSION });
      return;
    }
    const name = String(message.name || '').slice(0, 64) || 'Player';
    if (this.roomName && !this.model.roomName) this.model.roomName = this.roomName;
    if (message.roomId && !this.model.roomName) this.model.roomName = String(message.roomId);

    // Token is the sole identity: a new socket with the same token displaces the
    // old one (e.g. a duplicate tab). The old tab is told to stand down.
    for (const other of this.state.getWebSockets()) {
      if (other === socket) continue;
      const otherMeta = other.deserializeAttachment() || {};
      if (otherMeta.token === token) {
        this.send(other, { type: 'displaced' });
        try { other.close(1000, 'displaced'); } catch { /* no-op */ }
      }
    }

    socket.serializeAttachment({ token });

    const membershipChanged = this.upsertMember(token, name);

    // Reconnected within grace: cancel the pending drop. No roster blip.
    if (this.model.pendingDrop[token] != null) {
      delete this.model.pendingDrop[token];
    }

    const now = Date.now();
    let hostAssigned = false;
    let joinPresence = null;
    if (!this.model.game) {
      // First arrival creates the room (creator seated black, host/admin).
      this.model.game = createRoom({
        roomId: this.model.roomName || message.roomId || '',
        hostToken: token,
        hostName: name,
        settings: parseSettings(message.settings),
        now,
      });
      this.model.hostToken = token;
      hostAssigned = true;
    } else {
      // Returning or new participant joins the existing authoritative game.
      const result = joinParticipant(this.model.game, token, name, { now });
      this.applyClockEffect(result.effects.clock, now);
      joinPresence = result.effects.presence || null;
      if (!this.model.hostToken) {
        this.model.hostToken = token;
        hostAssigned = true;
      }
    }

    this.syncHostIntoGame();

    await this.persist([
      'game', 'members', 'seqCounter', 'pendingDrop', 'hostToken',
      'clockArmed', 'clockDeadlineAt', 'roomName',
    ]);
    await this.rescheduleAlarm();

    this.send(socket, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      you: { token, role: this.model.hostToken === token ? 'host' : 'member' },
      roster: this.roster(),
    });
    this.send(socket, { type: 'game-state', state: this.model.game, serverNow: now });

    // Joining changed presence/participants; refresh everyone else and toast
    // the join/reconnect to them (not to the joiner).
    this.broadcastGameState(socket, joinPresence && joinPresence.length ? { presence: joinPresence } : undefined);
    if (membershipChanged || hostAssigned) this.broadcastRoster(socket);
  }

  async handleIntent(token, message) {
    if (!this.model.game) return;
    const intent = message.intent;
    if (!intent || typeof intent !== 'object') return;

    const now = Date.now();
    const wasPlaying = this.isGamePlaying();
    const { error, effects } = applyIntent(this.model.game, token, intent, { now });
    if (error) {
      const sock = this.findSocketByToken(token);
      if (sock) this.send(sock, { type: 'notice', message: error });
      return;
    }

    this.applyClockEffect(effects.clock, now);
    // Host stays put during play; if the game just ended (resign / draw) with
    // the host disconnected, hand off now.
    let rosterChanged = false;
    if (wasPlaying && !this.isGamePlaying() && !this.isHostConnected()) {
      this.electHost();
      this.syncHostIntoGame();
      rosterChanged = true;
    }
    await this.persist(['game', 'hostToken', 'clockArmed', 'clockDeadlineAt']);
    await this.rescheduleAlarm();
    // Carry the applied action so clients can play the right sound / highlight
    // (stone, swap / draw / takeback notification) without re-deriving it.
    this.broadcastGameState(null, { lastAction: { kind: intent.kind, actorPeerId: token } });
    if (rosterChanged) this.broadcastRoster(null);
  }

  async handleBye(socket, token) {
    let rosterChanged = false;
    if (this.model.members[token]) {
      delete this.model.members[token];
      rosterChanged = true;
    }
    if (this.model.pendingDrop[token] != null) delete this.model.pendingDrop[token];
    const presence = this.finalizeDeparture(token, Date.now());
    // Host stays put during play; a non-game host bye hands off now.
    if (this.model.hostToken === token && !this.isGamePlaying()) {
      this.electHost();
      rosterChanged = true;
    }
    if (rosterChanged) this.syncHostIntoGame();

    await this.persist(['game', 'members', 'pendingDrop', 'hostToken', 'clockArmed', 'clockDeadlineAt']);
    await this.rescheduleAlarm();
    if (presence) this.broadcastGameState(socket, presence.length ? { presence } : undefined);
    if (rosterChanged) this.broadcastRoster(socket);
    try { socket.close(1000, 'bye'); } catch { /* no-op */ }
  }

  async handleSocketGone(socket) {
    const meta = socket.deserializeAttachment() || {};
    const token = meta.token;
    if (!token) return;

    // A still-open OTHER socket with this token means a displacement just
    // happened; the old socket's close should not start a drop.
    if (this.findSocketByToken(token, socket)) return;
    if (!this.model.members[token]) return;

    this.model.pendingDrop[token] = Date.now() + PRESENCE_GRACE_MS;
    await this.persist(['pendingDrop']);
    await this.rescheduleAlarm();
    // No roster broadcast: the member stays listed during the grace window.
  }

  // ---- game / presence helpers ------------------------------------------

  // A seated mid-game player is preserved (paused) so they can reconnect;
  // anyone else is removed. Returns the presence toasts to broadcast (an array,
  // possibly empty) when a participant departed, or null if there was none.
  finalizeDeparture(token, now) {
    if (!this.model.game || !this.model.game.participantsById[token]) return null;
    const preserved = preserveDisconnected(this.model.game, token, { now });
    if (preserved.preserved) {
      this.applyClockEffect(preserved.effects.clock, now);
      return preserved.effects.presence || [];
    }
    const removed = removeParticipant(this.model.game, token, { now });
    this.applyClockEffect(removed.effects.clock, now);
    return removed.effects.presence || [];
  }

  syncHostIntoGame() {
    if (!this.model.game) return;
    const host = this.model.hostToken;
    this.model.game.hostPeerId = host || '';
    for (const participant of Object.values(this.model.game.participantsById || {})) {
      if (participant) participant.isHost = Boolean(host) && participant.id === host;
    }
  }

  // Translate an engine clock effect into the DO's deadline timer.
  applyClockEffect(clock, now) {
    if (!clock) return;
    if (clock.armed) {
      this.model.clockArmed = true;
      this.model.clockDeadlineAt = now + Math.max(0, clock.remainingMs || 0) + CLOCK_LATENCY_GRACE_MS;
    } else {
      this.model.clockArmed = false;
      this.model.clockDeadlineAt = 0;
    }
  }

  upsertMember(token, name) {
    const existing = this.model.members[token];
    if (existing) {
      const changed = existing.name !== name;
      existing.name = name;
      return changed;
    }
    this.model.seqCounter += 1;
    this.model.members[token] = { name, joinSeq: this.model.seqCounter };
    return true;
  }

  isGamePlaying() {
    return Boolean(this.model.game && this.model.game.status === 'playing');
  }

  // The host counts as connected only with a live socket and no pending drop.
  isHostConnected() {
    const token = this.model.hostToken;
    if (!token) return false;
    if (this.model.pendingDrop[token] != null) return false;
    return Boolean(this.findSocketByToken(token));
  }

  electHost() {
    let best = '';
    let bestSeq = Infinity;
    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment() || {};
      const token = meta.token;
      if (!token) continue;
      const member = this.model.members[token];
      if (!member) continue;
      if (this.model.pendingDrop[token] != null) continue;
      const seq = member.joinSeq ?? Infinity;
      if (seq < bestSeq) {
        bestSeq = seq;
        best = token;
      }
    }
    this.model.hostToken = best;
  }

  async rescheduleAlarm() {
    const deadlines = Object.values(this.model.pendingDrop);
    if (this.model.clockArmed && this.model.clockDeadlineAt) {
      deadlines.push(this.model.clockDeadlineAt);
    }
    if (deadlines.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.min(...deadlines));
  }

  roster() {
    return {
      hostToken: this.model.hostToken,
      members: Object.entries(this.model.members).map(([token, member]) => ({
        token,
        name: member.name,
      })),
    };
  }

  broadcastRoster(excludeSocket) {
    const payload = { type: 'roster', roster: this.roster() };
    for (const socket of this.state.getWebSockets()) {
      if (socket === excludeSocket) continue;
      const meta = socket.deserializeAttachment() || {};
      if (!meta.token) continue;
      this.send(socket, payload);
    }
  }

  broadcastGameState(excludeSocket, extra) {
    if (!this.model.game) return;
    const payload = JSON.stringify({
      type: 'game-state',
      state: this.model.game,
      serverNow: Date.now(),
      ...(extra || {}),
    });
    for (const socket of this.state.getWebSockets()) {
      if (socket === excludeSocket) continue;
      const meta = socket.deserializeAttachment() || {};
      if (!meta.token) continue;
      try { socket.send(payload); } catch { /* no-op */ }
    }
  }

  findSocketByToken(token, excludeSocket) {
    const normalized = String(token || '').trim();
    if (!normalized) return null;
    for (const socket of this.state.getWebSockets()) {
      if (socket === excludeSocket) continue;
      const meta = socket.deserializeAttachment() || {};
      if (meta.token === normalized) return socket;
    }
    return null;
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // no-op
    }
  }
}
