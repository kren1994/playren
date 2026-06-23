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

    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment(this.createSocketMeta());
    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket, rawData) {
    this.handleMessage(socket, rawData);
  }

  async webSocketClose(socket, code, reason) {
    this.handleClose(socket, String(reason || ''));
    socket.close(code, reason);
  }

  async webSocketError(socket) {
    this.handleClose(socket);
  }

  handleMessage(socket, rawData) {
    if (rawData === 'ping' || rawData === 'pong') return;
    if (typeof rawData !== 'string') return;

    let message;
    try {
      message = JSON.parse(rawData);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'peer-open') {
      this.handlePeerOpen(socket, message);
      return;
    }

    const meta = this.getSocketMeta(socket);
    if (!meta.peerId) {
      this.send(socket, {
        type: 'peer-error',
        errorType: 'not-opened',
        message: 'Peer is not opened yet.',
      });
      return;
    }

    if (message.type === 'connect-request') {
      this.handleConnectRequest(socket, message);
      return;
    }

    if (message.type === 'connection-data') {
      this.forwardConnectionData(socket, message);
      return;
    }

    if (message.type === 'connection-close') {
      this.closeConnection(socket, String(message.connectionId || ''), true, String(message.closeReason || ''));
    }
  }

  handlePeerOpen(socket, message) {
    const meta = this.getSocketMeta(socket);
    if (meta.peerId) return;

    const requested = String(message.requestedPeerId || '').trim();
    let peerId = requested;
    if (!peerId) {
      peerId = this.generatePeerId();
    }

    if (this.findPeerSocket(peerId)) {
      this.send(socket, {
        type: 'peer-error',
        errorType: 'unavailable-id',
        message: 'Requested peer id is already used.',
      });
      return;
    }

    meta.peerId = peerId;
    meta.roomId = String(message.roomId || '');
    this.setSocketMeta(socket, meta);

    this.send(socket, {
      type: 'peer-opened',
      peerId,
    });
  }

  handleConnectRequest(socket, message) {
    const sourceMeta = this.getSocketMeta(socket);
    if (!sourceMeta.peerId) return;

    const sourcePeerId = sourceMeta.peerId;
    const targetPeerId = String(message.targetPeerId || '').trim();
    const connectionId = String(message.connectionId || '').trim();

    if (!targetPeerId || !connectionId) {
      this.send(socket, {
        type: 'connect-rejected',
        connectionId,
        errorType: 'invalid-connection',
        message: 'Missing target peer or connection id.',
      });
      return;
    }

    const targetSocket = this.findPeerSocket(targetPeerId);
    if (!targetSocket) {
      this.send(socket, {
        type: 'connect-rejected',
        connectionId,
        errorType: 'peer-unavailable',
        message: 'Target peer is unavailable.',
      });
      return;
    }

    const targetMeta = this.getSocketMeta(targetSocket);
    sourceMeta.connections[connectionId] = targetPeerId;
    targetMeta.connections[connectionId] = sourcePeerId;
    this.setSocketMeta(socket, sourceMeta);
    this.setSocketMeta(targetSocket, targetMeta);

    this.send(targetSocket, {
      type: 'incoming-connection',
      connectionId,
      peerId: sourcePeerId,
      metadata: message.metadata || {},
    });

    this.send(socket, {
      type: 'connect-opened',
      connectionId,
      peerId: targetPeerId,
    });
  }

  forwardConnectionData(socket, message) {
    const meta = this.getSocketMeta(socket);
    const connectionId = String(message.connectionId || '').trim();
    if (!connectionId) return;

    const targetPeerId = meta.connections[connectionId] || '';
    if (!targetPeerId) return;

    const targetSocket = this.findPeerSocket(targetPeerId);
    if (!targetSocket) {
      this.closeConnection(socket, connectionId, true);
      return;
    }

    this.send(targetSocket, {
      type: 'connection-data',
      connectionId,
      data: message.data,
    });
  }

  closeConnection(socket, connectionId, notifyPeer, closeReason = '') {
    if (!connectionId) return;
    const meta = this.getSocketMeta(socket);
    const targetPeerId = meta.connections[connectionId] || '';
    if (!targetPeerId) return;

    delete meta.connections[connectionId];
    this.setSocketMeta(socket, meta);

    const targetSocket = this.findPeerSocket(targetPeerId);
    if (!targetSocket) return;

    const targetMeta = this.getSocketMeta(targetSocket);
    delete targetMeta.connections[connectionId];
    this.setSocketMeta(targetSocket, targetMeta);

    if (!notifyPeer) return;
    this.send(targetSocket, {
      type: 'connection-close',
      connectionId,
      closeReason,
    });
  }

  handleClose(socket) {
    const meta = this.getSocketMeta(socket);
    if (!meta.peerId) return;

    for (const [connectionId, otherPeerId] of Object.entries(meta.connections)) {
      const otherSocket = this.findPeerSocket(otherPeerId);
      if (otherSocket) {
        const otherMeta = this.getSocketMeta(otherSocket);
        delete otherMeta.connections[connectionId];
        this.setSocketMeta(otherSocket, otherMeta);
        this.send(otherSocket, {
          type: 'connection-close',
          connectionId,
        });
      }
    }

    this.setSocketMeta(socket, this.createSocketMeta());
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // no-op
    }
  }

  generatePeerId() {
    return 'p-' + crypto.randomUUID().slice(0, 12);
  }

  createSocketMeta() {
    return {
      peerId: '',
      roomId: '',
      connections: {},
    };
  }

  getSocketMeta(socket) {
    const meta = socket.deserializeAttachment();
    if (!meta || typeof meta !== 'object') return this.createSocketMeta();
    return {
      peerId: String(meta.peerId || ''),
      roomId: String(meta.roomId || ''),
      connections: this.normalizeConnections(meta.connections),
    };
  }

  setSocketMeta(socket, meta) {
    socket.serializeAttachment({
      peerId: String(meta.peerId || ''),
      roomId: String(meta.roomId || ''),
      connections: this.normalizeConnections(meta.connections),
    });
  }

  normalizeConnections(connections) {
    if (!connections || typeof connections !== 'object') return {};
    return Object.fromEntries(
      Object.entries(connections)
        .map(([connectionId, peerId]) => [String(connectionId || '').trim(), String(peerId || '').trim()])
        .filter(([connectionId, peerId]) => connectionId && peerId)
    );
  }

  findPeerSocket(peerId) {
    const normalizedPeerId = String(peerId || '').trim();
    if (!normalizedPeerId) return null;

    for (const socket of this.state.getWebSockets()) {
      const meta = this.getSocketMeta(socket);
      if (meta.peerId === normalizedPeerId) return socket;
    }

    return null;
  }
}