(function () {
    'use strict';

    // Set this to your deployed worker URL in production.
    // Example: 'wss://your-worker-subdomain.workers.dev/ws-peer'
    //const DEFAULT_WORKER_ENDPOINT = '';
    const DEFAULT_WORKER_ENDPOINT = 'wss://playren-ws-worker.kamrenju.workers.dev/ws-peer';
    const LOCAL_WORKER_ENDPOINT = 'ws://127.0.0.1:8787/ws-peer';

    const query = new URLSearchParams(window.location.search);
    const fromQuery = String(query.get('wsEndpoint') || '').trim();
    const fromStorage = String(window.localStorage.getItem('playren:ws-endpoint') || '').trim();

    const isLocalPage = window.location.hostname === '127.0.0.1'
        || window.location.hostname === 'localhost';
    const endpoint = fromQuery
        || (isLocalPage ? LOCAL_WORKER_ENDPOINT : (fromStorage || DEFAULT_WORKER_ENDPOINT));
    if (fromQuery) {
        try {
            window.localStorage.setItem('playren:ws-endpoint', fromQuery);
        } catch (error) {
            // no-op
        }
    }

    if (endpoint) {
        window.WULIN_WS_ENDPOINT = endpoint;
    }
})();
