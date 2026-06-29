(function () {
    'use strict';

    // Must match PROTOCOL_VERSION in ws-worker/src/index.js.
    // v2: the Durable Object is the authoritative game server. Clients send
    // intents and render the full state the server broadcasts. There is no
    // host-mesh / DataConnection emulation and no host role; all peers are equal.
    const PROTOCOL_VERSION = 2;

    // Self-heal keepalive. The Durable Object auto-responds to 'ping' with
    // 'pong' (setWebSocketAutoResponse), so this only ever closes OUR OWN socket
    // when the server is unreachable. Presence is decided by the server.
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
            this._settings = opts.settings || null;

            this._emitter = createEmitter();
            this._ready = false;
            this._roster = new Map();

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
                    roomId: this._roomId,
                    ...(this._settings ? { settings: this._settings } : {}),
                });
                this._startHeartbeat();
            });

            this._socket.addEventListener('message', (event) => {
                this._onMessage(event.data);
            });

            this._socket.addEventListener('close', () => {
                this._stopHeartbeat();
                this.disconnected = true;
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

        // The one game channel: send a player intent to the authoritative server.
        sendIntent(intent) {
            if (!intent || typeof intent !== 'object') return;
            this._send({ type: 'intent', intent });
        }

        // Explicit leave: removes us immediately (no presence grace wait).
        bye() {
            this._send({ type: 'bye' });
        }

        // Is this token currently present (connected, or within presence grace)
        // per the server roster?
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
                case 'game-state':
                    this._emitter.emit('game-state', {
                        state: message.state,
                        serverNow: Number(message.serverNow || 0),
                        lastAction: message.lastAction || null,
                        presence: Array.isArray(message.presence) ? message.presence : null,
                    });
                    return;
                case 'notice':
                    this._emitter.emit('notice', { message: String(message.message || '') });
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

            const members = Array.isArray(roster.members) ? roster.members : [];
            this._roster = new Map(
                members.map((m) => [String(m.token || ''), String(m.name || '')])
            );

            this._emitter.emit('roster', roster);
        }
    }

    window.Peer = Peer;
})();
