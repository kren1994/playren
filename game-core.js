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

    // ---- board / opening / takeback transitions (Step 1.2) -----------------
    // All take the injected ctx so they can run host-side (parity) or in the
    // worker later. Error returns are i18n keys via ctx.i18n.

    function isOccupied(ctx, x, y) {
        const state = ctx.state;
        return state?.moves?.some((move) => move.x === x && move.y === y) || false;
    }

    function validateOfferMove(ctx, x, y) {
        const state = ctx.state;
        if (isOccupied(ctx, x, y)) return ctx.i18n('errOfferOccupied');
        if (state.opening.offeredMoves.some((move) => move.x === x && move.y === y)) {
            return ctx.i18n('errOfferDuplicated');
        }
        const candidateHash = getShapeHash(state.moves.concat([{ x, y, color: 'black' }]));
        const isSymmetric = state.opening.offeredMoves.some((offer) => {
            const existingHash = getShapeHash(state.moves.concat([{ x: offer.x, y: offer.y, color: 'black' }]));
            return candidateHash === existingHash;
        });
        if (isSymmetric) return ctx.i18n('errOfferSymmetric');
        return '';
    }

    function setPhase(ctx, nextPhase, timestamp) {
        const state = ctx.state;
        if (!state) return;
        state.phase = nextPhase;
        if (nextPhase === 'waiting-guest') {
            state.status = 'waiting';
            ctx.stopClock();
            return;
        }
        if (nextPhase === 'finished') {
            state.status = 'finished';
            ctx.stopClock();
            return;
        }
        state.status = 'playing';
        const descriptor = phaseDescriptor(ctx);
        if (descriptor.actorPeerId) {
            ctx.startClockFor(descriptor.actorPeerId, timestamp);
        } else {
            ctx.stopClock();
        }
    }

    function placeMove(ctx, peerId, x, y, timestamp) {
        const state = ctx.state;
        if (state?.takebackOfferByPeerId) return ctx.i18n('errTakebackAlready');
        if (state?.drawOfferByPeerId && state.drawOfferByPeerId !== peerId) {
            state.drawOfferByPeerId = '';
            state.drawResponderPeerId = '';
        }
        const originalPhase = state?.phase || '';
        const implicitPhase = getImplicitMovePhase(originalPhase);
        if (implicitPhase) {
            const swapDescriptor = phaseDescriptor(ctx);
            if (peerId !== swapDescriptor.actorPeerId) return ctx.i18n('errNotYourTurn');
            state.phase = implicitPhase;
        }

        const descriptor = phaseDescriptor(ctx);
        if (!descriptor.allowBoardAction || descriptor.boardActionKind !== 'move') {
            if (implicitPhase) state.phase = originalPhase;
            return ctx.i18n('errNotBoardAction');
        }
        if (peerId !== descriptor.actorPeerId) {
            if (implicitPhase) state.phase = originalPhase;
            return ctx.i18n('errNotYourTurn');
        }
        if (isOccupied(ctx, x, y)) {
            if (implicitPhase) state.phase = originalPhase;
            return ctx.i18n('errReviewOccupied');
        }
        if (!validateMoveConstraint(descriptor.constraint, x, y, ctx.center)) {
            if (implicitPhase) state.phase = originalPhase;
            return ctx.i18n('errConstraintOut');
        }

        ctx.applyElapsedTime(timestamp);

        const color = ctx.getColorForPeer(peerId);
        const moveNumber = state.moves.length + 1;
        state.moves.push({
            x,
            y,
            color,
            peerId,
            number: moveNumber,
            ...(state.pairRenjuEnabled ? { pairTurnIndex: state.pairTurnIndex } : {}),
        });
        ctx.grantIncrement(peerId);
        ctx.advancePairTurn();

        switch (state.phase) {
            case 'opening-move-1': setPhase(ctx, 'swap-after-1', timestamp); break;
            case 'opening-move-2': setPhase(ctx, 'swap-after-2', timestamp); break;
            case 'opening-move-3': setPhase(ctx, 'swap-after-3', timestamp); break;
            case 'opening-move-4': setPhase(ctx, 'swap-after-4', timestamp); break;
            case 'opening-move-5-choice1': setPhase(ctx, 'swap-after-5', timestamp); break;
            case 'opening-move-6-choice1':
            case 'opening-move-6-choice2':
            case 'regular': setPhase(ctx, 'regular', timestamp); break;
            default: break;
        }
        return '';
    }

    function resolveSwap(ctx, peerId, shouldSwap, timestamp) {
        const state = ctx.state;
        const descriptor = phaseDescriptor(ctx);
        if (!state || !state.phase.startsWith('swap-after-')) return ctx.i18n('errCannotSwap');
        if (peerId !== descriptor.actorPeerId) return ctx.i18n('errNotSwapTurn');

        ctx.applyElapsedTime(timestamp);
        const previousActorPeerId = descriptor.actorPeerId;
        if (shouldSwap) ctx.swapColors();
        ctx.advancePairTurn();

        if (state.phase === 'swap-after-1') setPhase(ctx, 'opening-move-2', timestamp);
        if (state.phase === 'swap-after-2') setPhase(ctx, 'opening-move-3', timestamp);
        if (state.phase === 'swap-after-3') setPhase(ctx, 'opening-move-4', timestamp);
        if (state.phase === 'swap-after-4') setPhase(ctx, 'opening-move-5-choice1', timestamp);
        if (state.phase === 'swap-after-5') setPhase(ctx, 'opening-move-6-choice1', timestamp);
        ctx.grantIncrementIfTurnPasses(peerId, previousActorPeerId);
        return '';
    }

    function chooseBranch(ctx, peerId, branch, timestamp) {
        const state = ctx.state;
        const descriptor = phaseDescriptor(ctx);
        if (state?.phase !== 'swap-after-4') return ctx.i18n('errCannotChoice');
        if (peerId !== descriptor.actorPeerId) return ctx.i18n('errOnlyBlackChoice');
        if (branch !== 'choice2') return '';

        ctx.applyElapsedTime(timestamp);
        state.opening.variant = branch;
        state.opening.offeredMoves = [];
        setPhase(ctx, 'offering-choice2', timestamp);
        return '';
    }

    function offerMove(ctx, peerId, x, y, timestamp) {
        const state = ctx.state;
        const descriptor = phaseDescriptor(ctx);
        if (state?.phase !== 'offering-choice2') return ctx.i18n('errNotOfferPhase');
        if (peerId !== descriptor.actorPeerId) return ctx.i18n('errOnlyBlackOffer');
        const error = validateOfferMove(ctx, x, y);
        if (error) return error;

        ctx.applyElapsedTime(timestamp);
        const previousActorPeerId = descriptor.actorPeerId;
        state.opening.offeredMoves.push({ x, y });

        if (state.opening.offeredMoves.length >= 10) {
            ctx.advancePairTurn();
            setPhase(ctx, 'select-offer', timestamp);
        } else {
            setPhase(ctx, 'offering-choice2', timestamp);
        }
        ctx.grantIncrementIfTurnPasses(peerId, previousActorPeerId);
        return '';
    }

    function selectOfferedMove(ctx, peerId, x, y, timestamp) {
        const state = ctx.state;
        const descriptor = phaseDescriptor(ctx);
        const previousActorPeerId = descriptor.actorPeerId;
        if (state?.phase !== 'select-offer') return ctx.i18n('errNotSelectPhase');
        if (peerId !== descriptor.actorPeerId) return ctx.i18n('errOnlyWhiteSelect');
        const selected = state.opening.offeredMoves.find((move) => move.x === x && move.y === y);
        if (!selected) return ctx.i18n('errSelectFromOffers');

        ctx.applyElapsedTime(timestamp);
        const blackPeerId = ctx.getBlackPeerId();
        const moveNumber = state.moves.length + 1;
        state.moves.push({
            x: selected.x,
            y: selected.y,
            color: 'black',
            peerId: blackPeerId,
            number: moveNumber,
            offered: true,
            ...(state.pairRenjuEnabled ? { pairTurnIndex: state.pairTurnIndex } : {}),
        });
        state.opening.offeredMoves = [];
        setPhase(ctx, 'opening-move-6-choice2', timestamp);
        ctx.grantIncrementIfTurnPasses(peerId, previousActorPeerId);
        return '';
    }

    function getTakebackRequestError(ctx, peerId) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return ctx.i18n('errTakebackPlayingOnly');
        const participant = ctx.getParticipantById(peerId);
        if (!ctx.isSeatedParticipant(participant)) return ctx.i18n('errTakebackPlayerOnly');
        if ((state.moves || []).length <= 6) return ctx.i18n('errTakebackTooEarly');
        const opponentPeerId = ctx.getOpponentPeerId(peerId);
        if (!opponentPeerId) return ctx.i18n('errTakebackNoOpponent');
        if (state.takebackOfferByPeerId) return ctx.i18n('errTakebackAlready');
        return '';
    }

    function requestTakeback(ctx, peerId) {
        const state = ctx.state;
        const requestError = getTakebackRequestError(ctx, peerId);
        if (requestError) return requestError;
        state.takebackOfferByPeerId = peerId;
        if (state.pairRenjuEnabled) {
            const activePeerId = phaseDescriptor(ctx).actorPeerId;
            const proposerTeam = ctx.getTeamForPeer(peerId);
            const activeTeam = ctx.getTeamForPeer(activePeerId);
            const isOwnTeamTurn = proposerTeam === activeTeam;
            state.takebackMoveCount = isOwnTeamTurn ? 2 : 1;
            if (isOwnTeamTurn) {
                const opponentTeam = ctx.getOpponentTeam(proposerTeam);
                const lastOpponentMove = [...(state.moves || [])]
                    .reverse()
                    .find((move) => ctx.getTeamForPeer(move.peerId) === opponentTeam);
                state.takebackResponderPeerId = lastOpponentMove?.peerId || '';
            } else {
                state.takebackResponderPeerId = activePeerId;
            }
        } else {
            state.takebackMoveCount = 0;
            state.takebackResponderPeerId = ctx.getOpponentPeerId(peerId);
        }
        return '';
    }

    function applyTakeback(ctx, peerId, timestamp) {
        const state = ctx.state;
        if (!state || !state.moves?.length) return;
        ctx.applyElapsedTime(timestamp);
        if (state.pairRenjuEnabled) {
            const count = Math.min(state.takebackMoveCount || 1, state.moves.length);
            const firstRemovedMove = state.moves[state.moves.length - count];
            state.moves.splice(state.moves.length - count, count);
            if (Number.isInteger(firstRemovedMove?.pairTurnIndex)) {
                state.pairTurnIndex = firstRemovedMove.pairTurnIndex;
            }
        } else {
            do {
                state.moves.pop();
            } while (state.moves.length && state.moves[state.moves.length - 1].peerId === peerId);
        }
        state.opening.offeredMoves = [];
        state.drawOfferByPeerId = '';
        state.drawResponderPeerId = '';
        state.takebackOfferByPeerId = '';
        state.takebackResponderPeerId = '';
        state.takebackMoveCount = 0;
        ctx.resetDisplayMoveCount();
        setPhase(ctx, 'regular', timestamp);
    }

    function respondTakeback(ctx, peerId, accept) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return ctx.i18n('errTakebackCannotRespond');
        const offerPeerId = state.takebackOfferByPeerId;
        if (!offerPeerId) return ctx.i18n('errTakebackNoOffer');
        const opponentPeerId = state.takebackResponderPeerId || ctx.getOpponentPeerId(offerPeerId);
        if (peerId !== opponentPeerId) return ctx.i18n('errTakebackOnlyOpponentRespond');
        if (!accept) {
            state.takebackOfferByPeerId = '';
            state.takebackResponderPeerId = '';
            state.takebackMoveCount = 0;
            return '';
        }
        applyTakeback(ctx, offerPeerId);
        return '';
    }

    // ---- match lifecycle / end / draw / resign (Step 1.3) ------------------
    // Logs are emitted as structured data (messageKey + args) via ctx.addLog,
    // so the worker can record them without localizing; the client localizes
    // at render time.

    function finishGame(ctx, winnerId, resultMessage, logMessage) {
        const state = ctx.state;
        if (!state) return;
        state.winnerId = winnerId || null;
        state.resultMessage = resultMessage && typeof resultMessage === 'object'
            ? resultMessage
            : null;
        state.resultText = ctx.renderMessageSpec(state.resultMessage, resultMessage);
        state.drawOfferByPeerId = '';
        state.drawResponderPeerId = '';
        state.takebackOfferByPeerId = '';
        state.takebackResponderPeerId = '';
        state.takebackMoveCount = 0;
        state.connectionPause = null;
        if (state.opening) state.opening.offeredMoves = [];
        if (logMessage) {
            const logSpec = logMessage && typeof logMessage === 'object' ? logMessage : null;
            ctx.addLog('system', ctx.renderMessageSpec(logSpec, logMessage), {
                action: 'copy-renjuportal-kifu',
                moves: (state.moves || []).slice(),
                ...(logSpec ? { messageKey: logSpec.key, messageArg: logSpec.arg } : {}),
            });
        }
        ctx.resetReadyFlags();
        setPhase(ctx, 'finished');
        ctx.resetReviewMoves();
    }

    function maybeStartMatch(ctx) {
        const state = ctx.state;
        if (!state || !['waiting-guest', 'finished'].includes(state.phase)
            || !ctx.allRequiredSeatsOccupied() || !ctx.allSeatedPlayersReady()) return;
        ctx.clearBoardForNewMatch();
        ctx.resetReadyFlags();
        ctx.initializePairTurnOrder();
        setPhase(ctx, 'opening-move-1');
    }

    function setReadyState(ctx, peerId, ready) {
        const state = ctx.state;
        if (!state || !peerId) return ctx.i18n('errNotReadyState');
        const participant = ctx.getParticipantById(peerId);
        if (!ctx.isSeatedParticipant(participant)) return ctx.i18n('errReadyPlayerOnly');
        if (state.status === 'playing') return ctx.i18n('errReadyNotPlaying');
        state.readyByPeerId[peerId] = Boolean(ready);
        maybeStartMatch(ctx);
        return '';
    }

    function getDrawRequestError(ctx, peerId) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return ctx.i18n('errDrawPlayingOnly');
        const participant = ctx.getParticipantById(peerId);
        if (!ctx.isSeatedParticipant(participant)) return ctx.i18n('errDrawPlayerOnly');
        const descriptor = phaseDescriptor(ctx);
        if (
            state.pairRenjuEnabled
                ? ctx.getTeamForPeer(descriptor.actorPeerId) === ctx.getTeamForPeer(peerId)
                : descriptor.actorPeerId === peerId
        ) {
            return ctx.i18n('errDrawNotYourTurn');
        }
        const opponentPeerId = state.pairRenjuEnabled ? descriptor.actorPeerId : ctx.getOpponentPeerId(peerId);
        if (!opponentPeerId) return ctx.i18n('errDrawNoOpponent');
        if (state.pairRenjuEnabled && state.drawOfferByPeerId) return ctx.i18n('errDrawAlready');
        if (state.drawOfferByPeerId === peerId) return ctx.i18n('errDrawAlready');
        return '';
    }

    function offerDraw(ctx, peerId) {
        const state = ctx.state;
        const requestError = getDrawRequestError(ctx, peerId);
        if (requestError) return requestError;
        const opponentPeerId = state.pairRenjuEnabled ? phaseDescriptor(ctx).actorPeerId : ctx.getOpponentPeerId(peerId);
        if (state.drawOfferByPeerId === opponentPeerId) {
            finishGame(ctx, '', ctx.messageSpec('msgDraw'), ctx.messageSpec('msgDrawLog'));
            return '';
        }
        state.drawOfferByPeerId = peerId;
        state.drawResponderPeerId = opponentPeerId;
        return '';
    }

    function respondDraw(ctx, peerId, accept) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return ctx.i18n('errDrawCannotRespond');
        const offerPeerId = state.drawOfferByPeerId;
        if (!offerPeerId) return ctx.i18n('errDrawNoOffer');
        const opponentPeerId = state.drawResponderPeerId || ctx.getOpponentPeerId(offerPeerId);
        if (peerId !== opponentPeerId) return ctx.i18n('errDrawOnlyOpponentRespond');
        if (accept) {
            finishGame(ctx, '', ctx.messageSpec('msgDraw'), ctx.messageSpec('msgDrawLog'));
            return '';
        }
        state.drawOfferByPeerId = '';
        state.drawResponderPeerId = '';
        return '';
    }

    function resignGame(ctx, peerId) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return ctx.i18n('errResignPlayingOnly');
        const participant = ctx.getParticipantById(peerId);
        if (!ctx.isSeatedParticipant(participant)) return ctx.i18n('errResignPlayerOnly');
        if (state.pairRenjuEnabled) {
            finishGame(ctx, '', null, ctx.messageSpec('msgAgreedEndLog'));
            return '';
        }
        const opponentPeerId = ctx.getOpponentPeerId(peerId);
        finishGame(ctx, opponentPeerId, ctx.messageSpec('msgWin', ctx.getPeerName(opponentPeerId)), ctx.messageSpec('msgAgreedEndLog'));
        return '';
    }

    root.GameCore = {
        getImplicitMovePhase,
        isInsideCenteredSquare,
        validateMoveConstraint,
        getShapeHash,
        phaseDescriptorBase,
        phaseDescriptor,
        isOccupied,
        validateOfferMove,
        setPhase,
        placeMove,
        resolveSwap,
        chooseBranch,
        offerMove,
        selectOfferedMove,
        getTakebackRequestError,
        requestTakeback,
        applyTakeback,
        respondTakeback,
        finishGame,
        maybeStartMatch,
        setReadyState,
        getDrawRequestError,
        offerDraw,
        respondDraw,
        resignGame,
    };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
