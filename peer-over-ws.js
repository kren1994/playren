(function () {
    'use strict';

    // Must match PROTOCOL_VERSION in ws-worker/src/index.js.
    const PROTOCOL_VERSION = 1;

    // Self-heal keepalive. The Durable Object auto-responds to 'ping' with
    // 'pong' (setWebSocketAutoResponse), so this only ever closes OUR OWN
    // socket when the server is unreachable. Peer presence is decided by the
    // server's roster, never by these probes.
    const HEARTBEAT_INTERVAL_MS = 30 * 1000;
    const PONG_TIMEOUT_MS = 10 * 1000;
    const HEARTBEAT_RETRY_DELAY_MS = 1000;
    const MAX_MISSED_PONGS = 2;

    function createEmitter() {
        const listeners = new Map();
        return {
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, []);
                listeners.get(event).push(handler);
            },
            emit(event, payload) {
                const handlers = listeners.get(event) || [];
                handlers.forEach((handler) => {
                    try {
                        handler(payload);
                    } catch (error) {
                        // Keep event loop resilient.
                    }
                });
            },
        };
    }

    // DataConnection-shaped facade over the star relay. There is no real
    // peer-to-peer link: send() routes a payload through the Durable Object to
    // a target token ('host' resolves to whoever is host right now).
    class WsDataConnection {
        constructor(peerRef, remoteToken, metadata, route) {
            this._peerRef = peerRef;
            this.peer = String(remoteToken || '');
            this.metadata = metadata || {};
            this._route = String(route || this.peer || '');
            this.open = false;
            this._closed = false;
            this._emitter = createEmitter();
        }

        on(event, handler) {
            this._emitter.on(event, handler);
        }

        _emit(event, payload) {
            this._emitter.emit(event, payload);
        }

        _markOpen() {
            if (this._closed || this.open) return;
            this.open = true;
            this._emit('open');
        }

        send(data) {
            if (this._closed || !this.open) return;
            this._peerRef._relay(this._route, data);
        }

        close() {
            // Local teardown only, and silent: an explicit close is not a peer
            // departure. Genuine departures arrive via the server roster.
            this._handleRemoteClose('', true);
        }

        _handleData(data) {
            if (this._closed) return;
            this._emit('data', data);
        }

        // silent=true tears down without a 'close' event. Used when OUR socket
        // dropped (the peer-level 'close' already covers it) so the app does not
        // mistake our own disconnect for every remote peer leaving.
        _handleRemoteClose(reason, silent) {
            if (this._closed) return;
            this._closed = true;
            this.open = false;
            if (!silent) this._emit('close', reason || '');
            this._peerRef._dropRemote(this.peer, this);
        }

        _handleError(err) {
            if (this._closed) return;
            this._emit('error', err || { type: 'network' });
        }
    }

    class Peer {
        constructor(roomId, options) {
            this.id = '';
            this.destroyed = false;
            this.disconnected = false;

            const opts = options || {};
            this._roomId = String(
                roomId ||
                opts.roomId ||
                window.__WULIN_ROOM_ID ||
                ''
            ).trim();
            this._token = String(opts.token || '').trim();
            this._name = String(opts.name || '');

            this._emitter = createEmitter();
            this._ready = false;
            this._role = '';
            this._hostToken = '';
            this._roster = new Map();
            this._remotes = new Map();
            this.snapshotVersion = 0; // latest authoritative version the server holds

            this._terminal = false; // displaced / protocol-mismatch: do not reconnect
            this._heartbeatTimer = 0;
            this._pongTimeoutTimer = 0;
            this._heartbeatRetryTimer = 0;
            this._missedPongs = 0;

            if (!this._roomId || !this._token) {
                queueMicrotask(() => {
                    this._emitter.emit('error', { type: 'invalid-id', message: 'Room id and token are required.' });
                });
                return;
            }

            const endpoint = String(
                window.WULIN_WS_ENDPOINT ||
                ((window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws-peer')
            ).trim();

            try {
                const url = new URL(endpoint, window.location.href);
                url.searchParams.set('room', this._roomId);
                this._socket = new WebSocket(url.toString());
            } catch (error) {
                queueMicrotask(() => {
                    this._emitter.emit('error', { type: 'network', message: 'Invalid websocket endpoint.' });
                });
                return;
            }

            this._socket.addEventListener('open', () => {
                this._send({
                    type: 'hello',
                    protocol: PROTOCOL_VERSION,
                    token: this._token,
                    name: this._name,
                });
                this._startHeartbeat();
            });

            this._socket.addEventListener('message', (event) => {
                this._onMessage(event.data);
            });

            this._socket.addEventListener('close', () => {
                this._stopHeartbeat();
                this.disconnected = true;
                this._closeAllRemotes();
                if (this._terminal) return;
                this._emitter.emit('close');
            });

            this._socket.addEventListener('error', () => {
                this._emitter.emit('error', { type: 'network', message: 'WebSocket connection error.' });
            });
        }

        on(event, handler) {
            this._emitter.on(event, handler);
        }

        // Guest -> host. Routes to whoever is host now, so a host migration
        // mid-flight still lands on the right socket.
        connect(targetToken, options) {
            const remoteToken = String(targetToken || '');
            const connection = new WsDataConnection(
                this,
                remoteToken,
                (options && options.metadata) || {},
                'host'
            );
            this._remotes.set(remoteToken, connection);
            queueMicrotask(() => connection._markOpen());
            return connection;
        }

        // Host -> all members in one relay (saves inbound traffic vs N sends).
        broadcast(data) {
            this._relay('*', data);
        }

        // Host pushes its authoritative state to the server (debounced by the
        // caller). The server keeps only newer versions.
        pushSnapshot(version, state) {
            this._send({ type: 'snapshot', version, state });
        }

        // Host pulls the server snapshot (used when its own copy is missing or
        // older than serverSnapshotVersion).
        requestSnapshot() {
            this._send({ type: 'snapshot-request' });
        }

        // Is this token currently present (connected, or within presence grace)
        // per the server roster? Used to reconcile seated-player presence after
        // adopting a snapshot.
        isMember(token) {
            return this._roster.has(String(token || ''));
        }

        setHeartbeatEnabled() {
            // Heartbeat is always on as a self-heal probe; kept for call-site
            // compatibility. Peer presence is server-driven.
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.disconnected = true;
            this._stopHeartbeat();
            this._closeAllRemotes();
            if (this._socket && this._socket.readyState <= WebSocket.OPEN) {
                try {
                    this._socket.close();
                } catch (error) {
                    // no-op
                }
            }
        }

        // ---- heartbeat (self-heal only) -----------------------------------

        _startHeartbeat() {
            this._stopHeartbeat();
            this._sendHeartbeatProbe();
            this._heartbeatTimer = window.setInterval(() => {
                this._sendHeartbeatProbe();
            }, HEARTBEAT_INTERVAL_MS);
        }

        _sendHeartbeatProbe() {
            if (this.destroyed) return;
            if (!this._socket || this._socket.readyState !== WebSocket.OPEN) return;
            if (this._pongTimeoutTimer) return;

            this._sendRaw('ping');
            this._pongTimeoutTimer = window.setTimeout(() => {
                this._handlePongTimeout();
            }, PONG_TIMEOUT_MS);
        }

        _handlePongTimeout() {
            this._pongTimeoutTimer = 0;
            this._missedPongs += 1;

            if (this._missedPongs >= MAX_MISSED_PONGS) {
                // Server unreachable: drop our own socket so the app reconnects.
                if (this._socket && this._socket.readyState === WebSocket.OPEN) {
                    try { this._socket.close(); } catch (error) { }
                }
                return;
            }

            this._heartbeatRetryTimer = window.setTimeout(() => {
                this._heartbeatRetryTimer = 0;
                this._sendHeartbeatProbe();
            }, HEARTBEAT_RETRY_DELAY_MS);
        }

        _markHeartbeatAlive() {
            this._missedPongs = 0;
            if (this._pongTimeoutTimer) {
                window.clearTimeout(this._pongTimeoutTimer);
                this._pongTimeoutTimer = 0;
            }
            if (this._heartbeatRetryTimer) {
                window.clearTimeout(this._heartbeatRetryTimer);
                this._heartbeatRetryTimer = 0;
            }
        }

        _stopHeartbeat() {
            if (this._heartbeatTimer) {
                window.clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = 0;
            }
            if (this._pongTimeoutTimer) {
                window.clearTimeout(this._pongTimeoutTimer);
                this._pongTimeoutTimer = 0;
            }
            if (this._heartbeatRetryTimer) {
                window.clearTimeout(this._heartbeatRetryTimer);
                this._heartbeatRetryTimer = 0;
            }
            this._missedPongs = 0;
        }

        // ---- transport ----------------------------------------------------

        _send(payload) {
            if (!this._socket || this._socket.readyState !== WebSocket.OPEN) return;
            try {
                this._socket.send(JSON.stringify(payload));
            } catch (error) {
                // no-op
            }
        }

        _sendRaw(data) {
            if (!this._socket || this._socket.readyState !== WebSocket.OPEN) return;
            try {
                this._socket.send(data);
            } catch (error) {
                // no-op
            }
        }

        _relay(to, data) {
            this._send({ type: 'relay', to: String(to || ''), data });
        }

        _dropRemote(token, connection) {
            if (this._remotes.get(token) === connection) {
                this._remotes.delete(token);
            }
        }

        _closeAllRemotes() {
            const remotes = Array.from(this._remotes.values());
            this._remotes.clear();
            remotes.forEach((connection) => connection._handleRemoteClose('', true));
        }

        // ---- inbound ------------------------------------------------------

        _onMessage(raw) {
            if (raw === 'pong') {
                this._markHeartbeatAlive();
                return;
            }

            let message;
            try {
                message = JSON.parse(raw);
            } catch (error) {
                return;
            }
            if (!message || typeof message !== 'object') return;

            this._markHeartbeatAlive();

            switch (message.type) {
                case 'welcome':
                    this._handleWelcome(message);
                    return;
                case 'roster':
                    this._applyRoster(message.roster);
                    return;
                case 'message':
                    this._handleRelayedMessage(message);
                    return;
                case 'snapshot':
                    this._emitter.emit('snapshot', { version: Number(message.version || 0), state: message.state });
                    return;
                case 'displaced':
                    this._terminal = true;
                    this._emitter.emit('displaced');
                    return;
                case 'protocol-mismatch':
                    this._terminal = true;
                    this._emitter.emit('protocol-mismatch', { server: message.server || 0 });
                    return;
                default:
                    return;
            }
        }

        _handleWelcome(message) {
            if (Number(message.protocol) !== PROTOCOL_VERSION) {
                this._terminal = true;
                this._emitter.emit('protocol-mismatch', { server: message.protocol || 0 });
                return;
            }
            this.id = this._token;
            if (!this._ready) {
                this._ready = true;
                this._emitter.emit('open', this.id);
            }
            this._applyRoster(message.roster);
        }

        _applyRoster(roster) {
            if (!roster || typeof roster !== 'object') return;

            const prevHostToken = this._hostToken;
            this._hostToken = String(roster.hostToken || '');
            this.snapshotVersion = Number(roster.snapshotVersion || 0);

            const members = Array.isArray(roster.members) ? roster.members : [];
            this._roster = new Map(
                members.map((m) => [String(m.token || ''), String(m.name || '')])
            );

            const wasHost = this._role === 'host';
            this._role = this._hostToken === this._token ? 'host' : 'member';

            if (this._hostToken !== prevHostToken) {
                this._emitter.emit('host-changed', this._hostToken);
            }

            this._reconcileRemotes(wasHost);
        }

        _reconcileRemotes(wasHost) {
            if (this._role === 'host') {
                // Ensure one connection per other member; close vanished ones.
                this._roster.forEach((name, token) => {
                    if (token === this._token) return;
                    if (this._remotes.has(token)) return;
                    this._createIncoming(token, name);
                });
                Array.from(this._remotes.keys()).forEach((token) => {
                    if (!this._roster.has(token)) {
                        const connection = this._remotes.get(token);
                        if (connection) connection._handleRemoteClose();
                    }
                });
            } else {
                // Member: only the host link matters. The app (re)connects to
                // the host on 'host-changed'; drop any other synthesized links.
                Array.from(this._remotes.keys()).forEach((token) => {
                    if (token !== this._hostToken) {
                        const connection = this._remotes.get(token);
                        if (connection) connection._handleRemoteClose();
                    }
                });
            }
        }

        _createIncoming(token, name) {
            const connection = new WsDataConnection(this, token, { name }, token);
            this._remotes.set(token, connection);
            this._emitter.emit('connection', connection);
            queueMicrotask(() => connection._markOpen());
            return connection;
        }

        _handleRelayedMessage(message) {
            const from = String(message.from || '');
            if (!from) return;

            let connection = this._remotes.get(from);
            if (!connection && this._role === 'host') {
                // Data arrived before the roster created the link (race).
                connection = this._createIncoming(from, this._roster.get(from) || '');
                connection._markOpen();
            }
            if (!connection) return;
            connection._handleData(message.data);
        }
    }

    window.Peer = Peer;
})();
