// Shared, UI-free renju game-core. Loaded as a side-effect module that sets
// globalThis.GameCore, so the same file works in the browser (<script src>)
// and in the Durable Object worker (import './game-core.js').
//
// Functions that need board/seat context receive an injected `ctx`:
//   { state, center, getBlackPeerId, getWhitePeerId, getOpponentPeerId,
//     getPairTurnActor, hasDisconnectedSeatedPlayer }
// so this module stays free of globals, DOM, i18n and networking.
(function (root) {
    'use strict';

    function getImplicitMovePhase(phase) {
        switch (phase) {
            case 'swap-after-1': return 'opening-move-2';
            case 'swap-after-2': return 'opening-move-3';
            case 'swap-after-3': return 'opening-move-4';
            case 'swap-after-4': return 'opening-move-5-choice1';
            case 'swap-after-5': return 'opening-move-6-choice1';
            default: return '';
        }
    }

    function isInsideCenteredSquare(x, y, radius, center) {
        return Math.abs(x - center) <= radius && Math.abs(y - center) <= radius;
    }

    function validateMoveConstraint(constraint, x, y, center) {
        if (!constraint || constraint.kind === 'anywhere') return true;
        if (constraint.kind === 'center') return x === center && y === center;
        if (constraint.kind === 'square') return isInsideCenteredSquare(x, y, constraint.radius, center);
        return true;
    }

    // Canonical hash of a stone shape under the 8 board symmetries; used to
    // reject Choice-2 offers that are symmetric duplicates.
    function getShapeHash(moves) {
        let minHash = null;
        for (let i = 0; i < 8; i++) {
            const transformed = moves.map((m) => {
                let tx, ty;
                switch (i) {
                    case 0: tx = m.x; ty = m.y; break;
                    case 1: tx = -m.y; ty = m.x; break;
                    case 2: tx = -m.x; ty = -m.y; break;
                    case 3: tx = m.y; ty = -m.x; break;
                    case 4: tx = -m.x; ty = m.y; break;
                    case 5: tx = m.y; ty = m.x; break;
                    case 6: tx = m.x; ty = -m.y; break;
                    case 7: tx = -m.y; ty = -m.x; break;
                }
                return { x: tx, y: ty, color: m.color };
            });

            let minX = Infinity;
            let minY = Infinity;
            for (const m of transformed) {
                if (m.x < minX) minX = m.x;
                if (m.y < minY) minY = m.y;
            }

            const normalized = transformed.map((m) => ({
                x: m.x - minX,
                y: m.y - minY,
                color: m.color,
            }));

            normalized.sort((a, b) => {
                if (a.x !== b.x) return a.x - b.x;
                if (a.y !== b.y) return a.y - b.y;
                return a.color.localeCompare(b.color);
            });

            const hash = normalized.map((m) => `${m.color[0]}${m.x},${m.y}`).join(';');
            if (minHash === null || hash < minHash) {
                minHash = hash;
            }
        }
        return minHash;
    }

    function phaseDescriptorBase(ctx) {
        const state = ctx.state;
        const center = ctx.center;
        if (!state) {
            return {
                label: '',
                detail: '',
                actorPeerId: '',
                allowBoardAction: false,
                boardActionKind: '',
                constraint: null,
            };
        }
        if (ctx.hasDisconnectedSeatedPlayer()) {
            return { actorPeerId: '', allowBoardAction: false, boardActionKind: '', constraint: null };
        }

        const blackPeerId = ctx.getBlackPeerId();
        const whitePeerId = ctx.getWhitePeerId();
        const lastMove = state.moves[state.moves.length - 1];

        switch (state.phase) {
            case 'waiting-guest':
                return { actorPeerId: '', allowBoardAction: false, boardActionKind: '', constraint: null };
            case 'opening-move-1':
                return { actorPeerId: blackPeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'center' } };
            case 'swap-after-1':
            case 'swap-after-2':
            case 'swap-after-3':
            case 'swap-after-5': {
                const implicitPhase = getImplicitMovePhase(state.phase);
                const currentActorPeerId = lastMove ? ctx.getOpponentPeerId(lastMove.peerId) : '';
                const savedPhase = state.phase;
                state.phase = implicitPhase;
                const implicitDescriptor = phaseDescriptor(ctx);
                state.phase = savedPhase;
                const actorPeerId = lastMove ? ctx.getOpponentPeerId(lastMove.peerId) : '';
                return {
                    actorPeerId,
                    allowBoardAction: Boolean(currentActorPeerId && implicitPhase),
                    boardActionKind: implicitPhase ? 'move' : '',
                    constraint: implicitDescriptor.constraint,
                };
            }
            case 'swap-after-4': {
                const implicitPhase = getImplicitMovePhase(state.phase);
                const savedPhase = state.phase;
                state.phase = implicitPhase;
                const implicitDescriptor = phaseDescriptor(ctx);
                state.phase = savedPhase;
                return {
                    actorPeerId: blackPeerId,
                    allowBoardAction: true,
                    boardActionKind: 'move',
                    constraint: implicitDescriptor.constraint,
                };
            }
            case 'opening-move-2':
                return { actorPeerId: whitePeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'square', radius: 1 } };
            case 'opening-move-3':
                return { actorPeerId: blackPeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'square', radius: 2 } };
            case 'opening-move-4':
                return { actorPeerId: whitePeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'square', radius: 3 } };
            case 'opening-move-5-choice1':
                return { actorPeerId: blackPeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'square', radius: 4 } };
            case 'opening-move-6-choice1':
                return { actorPeerId: whitePeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'anywhere' } };
            case 'offering-choice2':
                return { actorPeerId: blackPeerId, allowBoardAction: true, boardActionKind: 'offer', constraint: { kind: 'offer-set' } };
            case 'select-offer':
                return { actorPeerId: whitePeerId, allowBoardAction: true, boardActionKind: 'select-offer', constraint: { kind: 'select-offer' } };
            case 'opening-move-6-choice2':
                return { actorPeerId: whitePeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'anywhere' } };
            case 'regular': {
                const actorPeerId = lastMove ? ctx.getOpponentPeerId(lastMove.peerId) : blackPeerId;
                return { actorPeerId, allowBoardAction: true, boardActionKind: 'move', constraint: { kind: 'anywhere' } };
            }
            case 'finished':
                return { actorPeerId: '', allowBoardAction: false, boardActionKind: '', constraint: null };
            default:
                return { actorPeerId: '', allowBoardAction: false, boardActionKind: '', constraint: null };
        }
    }

    function phaseDescriptor(ctx) {
        const state = ctx.state;
        const descriptor = phaseDescriptorBase(ctx);
        if (
            state?.pairRenjuEnabled &&
            state.status === 'playing' &&
            descriptor.allowBoardAction
        ) {
            descriptor.actorPeerId = ctx.getPairTurnActor();
        }
        return descriptor;
    }

    root.GameCore = {
        getImplicitMovePhase,
        isInsideCenteredSquare,
        validateMoveConstraint,
        getShapeHash,
        phaseDescriptorBase,
        phaseDescriptor,
    };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
