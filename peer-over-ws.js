(function () {
    'use strict';

    const HEARTBEAT_INTERVAL_MS = 45 * 1000;
    const PONG_TIMEOUT_MS = 30 * 1000;

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

    class WsDataConnection {
        constructor(peerRef, connectionId, remotePeerId, metadata) {
            this._peerRef = peerRef;
            this._connectionId = connectionId;
            this.peer = remotePeerId;
            this.metadata = metadata || {};
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
            this._peerRef._send({
                type: 'connection-data',
                connectionId: this._connectionId,
                data,
            });
        }

        close(reason) {
            if (this._closed) return;
            this._peerRef._send({
                type: 'connection-close',
                connectionId: this._connectionId,
                closeReason: reason || '',
            });
            this._handleRemoteClose(reason || '');
        }

        _handleData(data) {
            if (this._closed) return;
            this._emit('data', data);
        }

        _handleRemoteClose(reason) {
            if (this._closed) return;
            this._closed = true;
            this.open = false;
            this._emit('close', reason || '');
            this._peerRef._dropConnection(this._connectionId);
        }

        _handleError(err) {
            if (this._closed) return;
            this._emit('error', err || { type: 'network' });
        }
    }

    class Peer {
        constructor(requestedId, options) {
            this.id = '';
            this.destroyed = false;
            this.disconnected = false;
            this._requestedId = requestedId || '';
            this._roomId = String(
                (options && options.roomId) ||
                this._requestedId ||
                window.__WULIN_ROOM_ID ||
                ''
            ).trim();
            this._emitter = createEmitter();
            this._connections = new Map();
            this._ready = false;
            this._heartbeatEnabled = false;
            this._heartbeatTimer = 0;
            this._pongTimeoutTimer = 0;

            if (!this._roomId) {
                queueMicrotask(() => {
                    this._emitter.emit('error', { type: 'invalid-id', message: 'Room id is required.' });
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
                    type: 'peer-open',
                    roomId: this._roomId,
                    requestedPeerId: this._requestedId || '',
                });
                if (this._heartbeatEnabled) this._startHeartbeat();
            });

            this._socket.addEventListener('message', (event) => {
                this._onMessage(event.data);
            });

            this._socket.addEventListener('close', () => {
                this._stopHeartbeat();
                this.disconnected = true;
                this._closeAllConnections();
                this._emitter.emit('close');
            });

            this._socket.addEventListener('error', () => {
                this._emitter.emit('error', { type: 'network', message: 'WebSocket connection error.' });
            });
        }

        on(event, handler) {
            this._emitter.on(event, handler);
        }

        connect(targetPeerId, options) {
            if (this.destroyed || !this._ready) {
                const pending = new WsDataConnection(this, this._createConnectionId(), String(targetPeerId || ''), options && options.metadata);
                queueMicrotask(() => pending._handleError({ type: 'network', message: 'Peer is not ready.' }));
                return pending;
            }

            const connectionId = this._createConnectionId();
            const connection = new WsDataConnection(
                this,
                connectionId,
                String(targetPeerId || ''),
                (options && options.metadata) || {}
            );
            this._connections.set(connectionId, connection);
            this._send({
                type: 'connect-request',
                connectionId,
                targetPeerId: String(targetPeerId || ''),
                metadata: connection.metadata,
            });
            return connection;
        }

        setHeartbeatEnabled(enabled) {
            this._heartbeatEnabled = Boolean(enabled);
            if (!this._heartbeatEnabled) {
                this._stopHeartbeat();
                return;
            }
            if (this._socket && this._socket.readyState === 1) {
                this._startHeartbeat();
            }
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.disconnected = true;
            this._stopHeartbeat();
            this._closeAllConnections();
            if (this._socket && this._socket.readyState <= 1) {
                try {
                    this._socket.close();
                } catch (error) {
                    // no-op
                }
            }
        }

        _createConnectionId() {
            return 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        }

        _startHeartbeat() {
            this._stopHeartbeat();
            this._heartbeatTimer = window.setInterval(() => {
                this._send({ type: 'ping', timestamp: Date.now() });
                this._pongTimeoutTimer = window.setTimeout(() => {
                    this._pongTimeoutTimer = 0;
                    if (this._socket && this._socket.readyState === 1) {
                        try { this._socket.close(); } catch (error) { }
                    }
                }, PONG_TIMEOUT_MS);
            }, HEARTBEAT_INTERVAL_MS);
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
        }

        _send(payload) {
            if (!this._socket || this._socket.readyState !== 1) return;
            try {
                this._socket.send(JSON.stringify(payload));
            } catch (error) {
                // no-op
            }
        }

        _dropConnection(connectionId) {
            this._connections.delete(connectionId);
        }

        _closeAllConnections() {
            this._connections.forEach((connection) => {
                connection._handleRemoteClose();
            });
            this._connections.clear();
        }

        _onMessage(raw) {
            let message;
            try {
                message = JSON.parse(raw);
            } catch (error) {
                return;
            }
            if (!message || typeof message !== 'object') return;

            if (message.type === 'pong') {
                if (this._pongTimeoutTimer) {
                    window.clearTimeout(this._pongTimeoutTimer);
                    this._pongTimeoutTimer = 0;
                }
                return;
            }

            if (message.type === 'peer-opened') {
                this.id = message.peerId;
                this._ready = true;
                this._emitter.emit('open', this.id);
                return;
            }

            if (message.type === 'peer-error') {
                this._emitter.emit('error', {
                    type: message.errorType || 'server-error',
                    message: message.message || 'Peer error',
                });
                return;
            }

            if (message.type === 'incoming-connection') {
                const connectionId = String(message.connectionId || '');
                if (!connectionId) return;
                const incoming = new WsDataConnection(
                    this,
                    connectionId,
                    String(message.peerId || ''),
                    message.metadata || {}
                );
                this._connections.set(connectionId, incoming);
                this._emitter.emit('connection', incoming);
                queueMicrotask(() => incoming._markOpen());
                return;
            }

            if (message.type === 'connect-opened') {
                const connection = this._connections.get(String(message.connectionId || ''));
                if (!connection) return;
                connection._markOpen();
                return;
            }

            if (message.type === 'connect-rejected') {
                const connection = this._connections.get(String(message.connectionId || ''));
                if (!connection) return;
                connection._handleError({ type: message.errorType || 'peer-unavailable', message: message.message || 'Connection rejected.' });
                connection._handleRemoteClose();
                return;
            }

            if (message.type === 'connection-data') {
                const connection = this._connections.get(String(message.connectionId || ''));
                if (!connection) return;
                connection._handleData(message.data);
                return;
            }

            if (message.type === 'connection-close') {
                const connection = this._connections.get(String(message.connectionId || ''));
                if (!connection) return;
                connection._handleRemoteClose(message.closeReason || '');
            }
        }
    }

    window.Peer = Peer;
})();
