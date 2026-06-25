const PROTOCOL_VERSION = 1;
const PRESENCE_GRACE_MS = 4000;
// Authoritative state snapshot kept so a room survives all participants
// briefly leaving: the first returner (elected host) restores from it.
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
// Slack before declaring a clock timeout, to absorb in-flight moves / latency.
const CLOCK_LATENCY_GRACE_MS = 800;

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

export class RoomRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.loaded = false;
    this.model = null;

    // Infra-level keepalive: the client pings, we auto-reply pong.
    // Used only for each client to self-heal its own socket; peer presence
    // is decided here in the Durable Object, never by client heartbeats.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  // ---- model (durable) ---------------------------------------------------
  // members:    { [token]: { name, joinSeq } }   connected OR within grace
  // hostToken:  string
  // seqCounter: number
  // pendingDrop:{ [token]: deadlineMs }          sockets gone, awaiting grace

  async ensureLoaded() {
    if (this.loaded) return;
    const stored = await this.state.storage.get([
      'members',
      'hostToken',
      'seqCounter',
      'pendingDrop',
      'snapshot',
      'snapshotVersion',
      'snapshotSavedAt',
      'clockEpoch',
      'clockArmed',
      'clockBudgetMs',
      'clockConsumedMs',
      'clockActiveSince',
      'clockGate',
      'clockTimedOutEpoch',
    ]);
    this.model = {
      members: stored.get('members') || {},
      hostToken: stored.get('hostToken') || '',
      seqCounter: stored.get('seqCounter') || 0,
      pendingDrop: stored.get('pendingDrop') || {},
      snapshot: stored.get('snapshot') || null,
      snapshotVersion: stored.get('snapshotVersion') || 0,
      snapshotSavedAt: stored.get('snapshotSavedAt') || 0,
      // ---- authoritative clock (C.1: deadline timer only) ----
      // epoch:        monotonic; arm/disarm/timeout tagged so stale ones drop
      // budgetMs:     remaining at the last arm
      // consumedMs:   active time accumulated across pauses
      // activeSince:  DO time the clock is currently counting from (null=paused)
      // gate:         seated tokens whose absence pauses the clock
      // timedOutEpoch:epoch that already fired a timeout (0 = none)
      clockEpoch: stored.get('clockEpoch') || 0,
      clockArmed: stored.get('clockArmed') || false,
      clockBudgetMs: stored.get('clockBudgetMs') || 0,
      clockConsumedMs: stored.get('clockConsumedMs') || 0,
      clockActiveSince: stored.get('clockActiveSince') ?? null,
      clockGate: stored.get('clockGate') || [],
      clockTimedOutEpoch: stored.get('clockTimedOutEpoch') || 0,
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

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ token: '' });
    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
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
    if (!meta.token) {
      return;
    }

    if (message.type === 'relay') {
      this.handleRelay(meta.token, message);
      return;
    }

    if (message.type === 'snapshot') {
      await this.handleSnapshot(meta.token, message);
      return;
    }

    if (message.type === 'snapshot-request') {
      this.handleSnapshotRequest(socket, meta.token);
      return;
    }

    if (message.type === 'clock-arm') {
      await this.handleClockArm(meta.token, message);
      return;
    }

    if (message.type === 'clock-disarm') {
      await this.handleClockDisarm(meta.token, message);
      return;
    }

    if (message.type === 'clock-gate') {
      await this.handleClockGate(meta.token, message);
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

    for (const [token, deadline] of Object.entries(this.model.pendingDrop)) {
      if (deadline > now) continue;
      delete this.model.pendingDrop[token];
      if (this.model.members[token]) {
        delete this.model.members[token];
        rosterChanged = true;
      }
      if (this.model.hostToken === token) {
        this.electHost();
        rosterChanged = true;
      }
    }

    // A finalized drop of a seated (gate) player pauses the clock.
    this.reevaluateClockPause();

    // Clock timeout: armed, counting, present, and past the deadline.
    let timedOut = false;
    if (this.model.clockArmed && !this.model.clockTimedOutEpoch
        && this.model.clockActiveSince != null
        && now >= this.clockDeadline()) {
      this.model.clockTimedOutEpoch = this.model.clockEpoch;
      this.model.clockActiveSince = null;
      timedOut = true;
    }

    await this.persist(['pendingDrop', 'members', 'hostToken']);
    await this.persistClock();
    await this.rescheduleAlarm();
    if (rosterChanged) this.broadcastRoster(null);
    if (timedOut) this.broadcastClockTimeout();
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
    const name = String(message.name || '').slice(0, 64);

    // Token is the sole identity: a new socket with the same token displaces
    // the old one (e.g. a duplicate tab). The old tab is told to stand down.
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

    // Reconnected within grace: cancel the pending drop. No roster change,
    // so guests never see a blip (this is the whole point of the grace).
    if (this.model.pendingDrop[token] != null) {
      delete this.model.pendingDrop[token];
      await this.rescheduleAlarm();
    }

    let hostAssigned = false;
    if (!this.model.hostToken) {
      this.model.hostToken = token;
      hostAssigned = true;
    }

    // A returning seated player may let the clock resume.
    this.reevaluateClockPause();

    await this.persist(['members', 'seqCounter', 'pendingDrop', 'hostToken']);
    await this.persistClock();
    await this.rescheduleAlarm();

    this.send(socket, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      you: { token, role: this.model.hostToken === token ? 'host' : 'member' },
      roster: this.roster(),
    });

    // If the clock already timed out while no host was around to finalize it,
    // hand the fact to whoever is host now so it is never dropped.
    if (this.model.hostToken === token && this.model.clockTimedOutEpoch) {
      this.send(socket, { type: 'clock-timeout', epoch: this.model.clockTimedOutEpoch });
    }

    if (membershipChanged || hostAssigned) {
      this.broadcastRoster(socket);
    }
  }

  handleRelay(fromToken, message) {
    const to = String(message.to || '');
    if (!to) return;
    const data = message.data;

    if (to === '*') {
      for (const socket of this.state.getWebSockets()) {
        const meta = socket.deserializeAttachment() || {};
        if (!meta.token || meta.token === fromToken) continue;
        this.send(socket, { type: 'message', from: fromToken, data });
      }
      return;
    }

    const targetToken = to === 'host' ? this.model.hostToken : to;
    if (!targetToken) return;

    const target = this.findSocketByToken(targetToken);
    if (!target) return;

    this.send(target, { type: 'message', from: fromToken, data });
  }

  // Only the current host owns the authoritative state. Store newer versions
  // (older or duplicate versions are ignored). No fan-out, debounced by the
  // client, so this is a low-rate write path.
  async handleSnapshot(token, message) {
    if (!token || token !== this.model.hostToken) return;
    const version = Number(message.version || 0);
    if (!version || version <= this.model.snapshotVersion) return;
    if (!message.state || typeof message.state !== 'object') return;

    this.model.snapshot = message.state;
    this.model.snapshotVersion = version;
    this.model.snapshotSavedAt = Date.now();
    await this.persist(['snapshot', 'snapshotVersion', 'snapshotSavedAt']);
  }

  // Host-only recovery: a (re)connecting or promoted host pulls the latest
  // authoritative state when its own copy is missing or stale.
  handleSnapshotRequest(socket, token) {
    if (!token || token !== this.model.hostToken) return;
    if (!this.snapshotFresh()) return;
    this.send(socket, {
      type: 'snapshot',
      version: this.model.snapshotVersion,
      state: this.model.snapshot,
    });
  }

  snapshotFresh() {
    if (!this.model.snapshot || !this.model.snapshotVersion) return false;
    return Date.now() - this.model.snapshotSavedAt <= SNAPSHOT_MAX_AGE_MS;
  }

  async handleBye(socket, token) {
    let rosterChanged = false;
    if (this.model.members[token]) {
      delete this.model.members[token];
      rosterChanged = true;
    }
    if (this.model.pendingDrop[token] != null) {
      delete this.model.pendingDrop[token];
    }
    if (this.model.hostToken === token) {
      this.electHost();
      rosterChanged = true;
    }
    this.reevaluateClockPause(); // a leaving seated player pauses the clock
    await this.persist(['members', 'pendingDrop', 'hostToken']);
    await this.persistClock();
    await this.rescheduleAlarm();
    if (rosterChanged) this.broadcastRoster(socket);
    try { socket.close(1000, 'bye'); } catch { /* no-op */ }
  }

  async handleSocketGone(socket) {
    const meta = socket.deserializeAttachment() || {};
    const token = meta.token;
    if (!token) return;

    // A still-open OTHER socket with this token means a displacement just
    // happened; the old socket's close should not start a drop. The closing
    // socket itself may still appear in getWebSockets(), so exclude it.
    if (this.findSocketByToken(token, socket)) return;
    if (!this.model.members[token]) return;

    this.model.pendingDrop[token] = Date.now() + PRESENCE_GRACE_MS;
    await this.persist(['pendingDrop']);
    await this.rescheduleAlarm();
    // No roster broadcast: the member stays listed during the grace window.
  }

  // ---- helpers -----------------------------------------------------------

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
    const clockAt = this.clockDeadline();
    if (clockAt !== Infinity) deadlines.push(clockAt);
    if (deadlines.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.min(...deadlines));
  }

  roster() {
    return {
      hostToken: this.model.hostToken,
      snapshotVersion: this.snapshotFresh() ? this.model.snapshotVersion : 0,
      clockEpoch: this.model.clockEpoch,
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

  // ---- clock (host-driven, DO is the authoritative deadline timer) -------

  async handleClockArm(token, message) {
    if (!token || token !== this.model.hostToken) return;
    const epoch = Number(message.epoch || 0);
    if (epoch < this.model.clockEpoch) return; // stale / reordered
    this.model.clockEpoch = epoch;
    this.model.clockArmed = true;
    this.model.clockBudgetMs = Math.max(0, Number(message.remainingMs || 0));
    this.model.clockConsumedMs = 0;
    this.model.clockGate = Array.isArray(message.gateTokens) ? message.gateTokens.map(String) : [];
    this.model.clockTimedOutEpoch = 0;
    this.model.clockActiveSince = this.clockGatePresent() ? Date.now() : null;
    await this.persistClock();
    await this.rescheduleAlarm();
  }

  async handleClockDisarm(token, message) {
    if (!token || token !== this.model.hostToken) return;
    const epoch = Number(message.epoch || 0);
    if (epoch < this.model.clockEpoch) return;
    this.model.clockEpoch = epoch;
    this.model.clockArmed = false;
    this.model.clockActiveSince = null;
    this.model.clockTimedOutEpoch = 0;
    await this.persistClock();
    await this.rescheduleAlarm();
  }

  async handleClockGate(token, message) {
    if (!token || token !== this.model.hostToken) return;
    this.model.clockGate = Array.isArray(message.gateTokens) ? message.gateTokens.map(String) : [];
    this.reevaluateClockPause();
    await this.persistClock();
    await this.rescheduleAlarm();
  }

  clockGatePresent() {
    return this.model.clockGate.every((token) => !!this.model.members[token]);
  }

  clockDeadline() {
    if (!this.model.clockArmed || this.model.clockTimedOutEpoch) return Infinity;
    if (this.model.clockActiveSince == null) return Infinity; // paused
    const remaining = this.model.clockBudgetMs - this.model.clockConsumedMs;
    return this.model.clockActiveSince + remaining + CLOCK_LATENCY_GRACE_MS;
  }

  // Resume when every gate player is present, pause when any is absent. Caller
  // persists + reschedules.
  reevaluateClockPause() {
    if (!this.model.clockArmed || this.model.clockTimedOutEpoch) return;
    const present = this.clockGatePresent();
    const counting = this.model.clockActiveSince != null;
    if (present && !counting) {
      this.model.clockActiveSince = Date.now();
    } else if (!present && counting) {
      this.model.clockConsumedMs += Date.now() - this.model.clockActiveSince;
      this.model.clockActiveSince = null;
    }
  }

  async persistClock() {
    await this.persist([
      'clockEpoch', 'clockArmed', 'clockBudgetMs', 'clockConsumedMs',
      'clockActiveSince', 'clockGate', 'clockTimedOutEpoch',
    ]);
  }

  broadcastClockTimeout() {
    const payload = { type: 'clock-timeout', epoch: this.model.clockEpoch };
    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment() || {};
      if (!meta.token) continue;
      this.send(socket, payload);
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
