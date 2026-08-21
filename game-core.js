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
        const blackPeerId = getBlackPeerId(ctx);
        const whitePeerId = getWhitePeerId(ctx);
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
                const currentActorPeerId = lastMove ? getOpponentPeerId(ctx,lastMove.peerId) : '';
                const savedPhase = state.phase;
                state.phase = implicitPhase;
                const implicitDescriptor = phaseDescriptor(ctx);
                state.phase = savedPhase;
                const actorPeerId = lastMove ? getOpponentPeerId(ctx,lastMove.peerId) : '';
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
                const actorPeerId = state.positionSetupActive && lastMove
                    ? (lastMove.color === 'black' ? whitePeerId : blackPeerId)
                    : (lastMove ? getOpponentPeerId(ctx,lastMove.peerId) : blackPeerId);
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
            descriptor.actorPeerId = getPairTurnActor(ctx);
        }
        return descriptor;
    }

    // ---- pure state / seat / color / turn helpers (Step 1.4) ---------------
    // All read/write ctx.state only (no clock timing, i18n or DOM), so the
    // worker and the browser share one implementation.

    function getParticipantById(ctx, peerId) {
        const state = ctx.state;
        if (!state || !peerId) return null;
        return state.participantsById?.[peerId] || null;
    }

    function isParticipantDisconnected(participant) {
        return Boolean(participant && participant.disconnectedAt);
    }

    function getActiveSeatKeys(ctx) {
        return ctx.state?.pairRenjuEnabled
            ? ['black', 'white', 'blackBottom', 'whiteBottom']
            : ['black', 'white'];
    }

    function isPlayingSeat(ctx, seat) {
        return getActiveSeatKeys(ctx).includes(seat);
    }

    function hasDisconnectedSeatedPlayer(ctx) {
        const state = ctx.state;
        if (!state) return false;
        return getActiveSeatKeys(ctx)
            .map((seat) => state.seats[seat])
            .some((peerId) => isParticipantDisconnected(getParticipantById(ctx, peerId)));
    }

    function getBlackPeerId(ctx) {
        const state = ctx.state;
        if (!state) return '';
        return Object.entries(state.colorsByPeerId || {}).find(([, color]) => color === 'black')?.[0] || state.seats?.black || '';
    }

    function getWhitePeerId(ctx) {
        const state = ctx.state;
        if (!state) return '';
        return Object.entries(state.colorsByPeerId || {}).find(([, color]) => color === 'white')?.[0] || state.seats?.white || '';
    }

    function getTeamForSeat(seat) {
        if (seat === 'black' || seat === 'blackBottom') return 'black';
        if (seat === 'white' || seat === 'whiteBottom') return 'white';
        return '';
    }

    function getSeatForPeer(ctx, peerId) {
        const state = ctx.state;
        if (!state || !peerId) return '';
        return getActiveSeatKeys(ctx).find((seat) => state.seats?.[seat] === peerId) || '';
    }

    function getTeamForPeer(ctx, peerId) {
        return getTeamForSeat(getSeatForPeer(ctx, peerId));
    }

    function isSeatedParticipant(ctx, participant) {
        return Boolean(participant && isPlayingSeat(ctx, participant.seat));
    }

    function getOpponentTeam(team) {
        return team === 'black' ? 'white' : team === 'white' ? 'black' : '';
    }

    function getPairTurnActor(ctx) {
        const state = ctx.state;
        if (!state?.pairRenjuEnabled || !state.pairTurnOrder?.length) return '';
        return state.pairTurnOrder[state.pairTurnIndex % state.pairTurnOrder.length] || '';
    }

    function advancePairTurn(ctx) {
        const state = ctx.state;
        if (!state?.pairRenjuEnabled || !state.pairTurnOrder?.length) return;
        state.pairTurnIndex = (state.pairTurnIndex + 1) % state.pairTurnOrder.length;
    }

    function getColorForPeer(ctx, peerId) {
        return ctx.state?.colorsByPeerId?.[peerId] || '';
    }

    function getOpponentPeerId(ctx, peerId) {
        const state = ctx.state;
        if (!state || !peerId) return '';
        const ids = [state.seats.black, state.seats.white].filter(Boolean);
        return ids.find((id) => id !== peerId) || '';
    }

    function allRequiredSeatsOccupied(ctx) {
        const state = ctx.state;
        const keys = getActiveSeatKeys(ctx);
        const ids = keys.map((seat) => state?.seats?.[seat]).filter(Boolean);
        return ids.length === keys.length && new Set(ids).size === ids.length;
    }

    function allSeatedPlayersReady(ctx) {
        const state = ctx.state;
        if (!allRequiredSeatsOccupied(ctx)) return false;
        return getActiveSeatKeys(ctx).every((seat) => state.readyByPeerId?.[state.seats[seat]]);
    }

    function resetReadyFlags(ctx) {
        const state = ctx.state;
        if (!state) return;
        getActiveSeatKeys(ctx).forEach((seat) => {
            if (state.seats[seat]) state.readyByPeerId[state.seats[seat]] = false;
        });
    }

    // ---- seat colors / seat-clock config / board reset (Step 2.0) ----------
    // Pure state logic that swap / match-start depend on. Clock bounds and
    // defaults are baked here as game rules (must match the index constants).

    const GC_DEFAULT_BASE_S = 5 * 60;   // DEFAULT_BASE_MINUTES * 60
    const GC_DEFAULT_INC_S = 3;         // DEFAULT_INCREMENT_SECONDS

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function normalizeClockSetting(setting) {
        const s = setting || {};
        const baseSeconds = Number(s.baseSeconds);
        const incrementSeconds = Number(s.incrementSeconds);
        return {
            baseSeconds: clamp(Number.isFinite(baseSeconds) && baseSeconds > 0 ? baseSeconds : GC_DEFAULT_BASE_S, 1, 180 * 60),
            incrementSeconds: clamp(Number.isFinite(incrementSeconds) ? incrementSeconds : GC_DEFAULT_INC_S, 0, 60),
        };
    }

    function ensureSeatColors(ctx) {
        const state = ctx.state;
        if (!state) return;
        if (!state.seatColors || typeof state.seatColors !== 'object') {
            const blackSeatPeerId = state.seats?.black || '';
            const whiteSeatPeerId = state.seats?.white || '';
            state.seatColors = {
                black: state.colorsByPeerId?.[blackSeatPeerId] || 'black',
                white: state.colorsByPeerId?.[whiteSeatPeerId] || 'white',
            };
        }
        const blackColor = state.seatColors.black === 'white' ? 'white' : 'black';
        state.seatColors.black = blackColor;
        state.seatColors.white = blackColor === 'black' ? 'white' : 'black';
    }

    function rebuildColors(ctx) {
        const state = ctx.state;
        if (!state) return;
        ensureSeatColors(ctx);
        const nextColors = {};
        getActiveSeatKeys(ctx).forEach((seat) => {
            const peerId = state.seats?.[seat];
            const color = state.seatColors?.[getTeamForSeat(seat)];
            if (peerId && (color === 'black' || color === 'white')) {
                nextColors[peerId] = color;
            }
        });
        state.colorsByPeerId = nextColors;
    }

    function ensureSeatClockSettings(ctx) {
        const state = ctx.state;
        if (!state) return;
        const fallback = normalizeClockSetting({
            baseSeconds: state.config?.baseSeconds ?? GC_DEFAULT_BASE_S,
            incrementSeconds: state.config?.incrementSeconds ?? GC_DEFAULT_INC_S,
        });
        if (!state.seatClockSettings || typeof state.seatClockSettings !== 'object') {
            state.seatClockSettings = { black: { ...fallback }, white: { ...fallback } };
        }
        state.seatClockSettings.black = normalizeClockSetting(state.seatClockSettings.black || fallback);
        state.seatClockSettings.white = normalizeClockSetting(state.seatClockSettings.white || fallback);
        state.timeHandicapEnabled = Boolean(state.timeHandicapEnabled);
        if (!state.timeHandicapEnabled) {
            state.seatClockSettings.white = { ...state.seatClockSettings.black };
        }
        state.config.baseSeconds = state.seatClockSettings.black.baseSeconds;
        state.config.incrementSeconds = state.seatClockSettings.black.incrementSeconds;
    }

    function syncSeatClockToParticipant(ctx, seat) {
        const state = ctx.state;
        if (!state || !state.clocks) return;
        ensureSeatClockSettings(ctx);
        const peerId = state.seats?.[seat];
        if (!peerId) return;
        const team = getTeamForSeat(seat);
        const clockKey = state.pairRenjuEnabled ? `team:${team}` : peerId;
        state.clocks.remainingMsByPeerId[clockKey] = state.seatClockSettings[team].baseSeconds * 1000;
    }

    function syncSeatClocksToParticipants(ctx) {
        syncSeatClockToParticipant(ctx, 'black');
        syncSeatClockToParticipant(ctx, 'white');
    }

    function swapSeatColors(ctx) {
        const state = ctx.state;
        if (!state) return;
        ensureSeatColors(ctx);
        const previousBlack = state.seatColors.black;
        state.seatColors.black = state.seatColors.white;
        state.seatColors.white = previousBlack;
        rebuildColors(ctx);
    }

    function swapColors(ctx) {
        swapSeatColors(ctx);
    }

    function clearBoardForNewMatch(ctx) {
        const state = ctx.state;
        if (!state) return;
        state.moves = [];
        state.reviewMoves = [];
        state.reviewCursor = 0;
        state.reviewBranchBaseCursor = null;
        state.opening = { variant: null, offeredMoves: [] };
        state.winnerId = null;
        state.resultText = '';
        state.resultMessage = null;
        state.drawOfferByPeerId = '';
        state.drawResponderPeerId = '';
        state.takebackOfferByPeerId = '';
        state.takebackResponderPeerId = '';
        state.takebackMoveCount = 0;
        state.connectionPause = null;
        state.clocks.remainingMsByPeerId = {};
        ensureSeatClockSettings(ctx);
        syncSeatClocksToParticipants(ctx);
        ctx.stopClock();
    }

    function initializePairTurnOrder(ctx) {
        const state = ctx.state;
        if (!state?.pairRenjuEnabled) {
            state.pairTurnOrder = [];
            state.pairTurnIndex = 0;
            return;
        }
        ensureSeatColors(ctx);
        const blackTeam = state.seatColors.black === 'black' ? 'black' : 'white';
        const whiteTeam = getOpponentTeam(blackTeam);
        state.pairTurnOrder = [
            state.seats[blackTeam],
            state.seats[whiteTeam],
            state.seats[`${blackTeam}Bottom`],
            state.seats[`${whiteTeam}Bottom`],
        ];
        state.pairTurnIndex = 0;
    }

    function clonePositionMoves(moves) {
        if (!Array.isArray(moves)) return [];
        return moves
            .filter((move) => Number.isInteger(move?.x) && Number.isInteger(move?.y)
                && (move.color === 'black' || move.color === 'white'))
            .map((move, index) => ({
                x: move.x,
                y: move.y,
                color: move.color,
                ...(move.peerId ? { peerId: move.peerId } : {}),
                number: index + 1,
            }));
    }

    function setPositionSetupEnabled(ctx, enabled, moves) {
        const state = ctx.state;
        if (!state || state.status === 'playing') return;
        ensurePairRenjuState(ctx);
        state.positionSetupEnabled = Boolean(enabled);
        resetReadyFlags(ctx);
    }

    function setPositionSetupStartMoves(ctx, moves) {
        const state = ctx.state;
        if (!state || state.status === 'playing' || !state.positionSetupEnabled) return;
        state.moves = clonePositionMoves(moves);
    }

    // ---- pure clock state ops (Step 2.1) -----------------------------------
    // These mutate state.clocks deterministically (time via the passed
    // timestamp / Date.now). The environment-specific side effects (browser
    // arming the DO timer; the DO deriving its own timeout) stay in the
    // injected startClockFor/stopClock wrappers, which call setActiveClock /
    // clearActiveClock for the shared state mutation.

    function getClockSettingForPeer(ctx, peerId) {
        ensureSeatClockSettings(ctx);
        const team = getTeamForPeer(ctx, peerId);
        return ctx.state?.seatClockSettings?.[team] || normalizeClockSetting();
    }

    function getClockKeyForPeer(ctx, peerId) {
        const state = ctx.state;
        if (!state?.pairRenjuEnabled) return peerId;
        const team = getTeamForPeer(ctx, peerId);
        return team ? `team:${team}` : peerId;
    }

    function ensureClockEntry(ctx, peerId) {
        const state = ctx.state;
        if (!state || !peerId) return;
        const clockKey = getClockKeyForPeer(ctx, peerId);
        if (state.clocks.remainingMsByPeerId[clockKey] == null) {
            state.clocks.remainingMsByPeerId[clockKey] = getClockSettingForPeer(ctx, peerId).baseSeconds * 1000;
        }
        if (state.readyByPeerId[peerId] == null) {
            state.readyByPeerId[peerId] = false;
        }
    }

    function applyElapsedTime(ctx, timestamp) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return;
        const ts = timestamp === undefined ? Date.now() : timestamp;
        const activePeerId = state.clocks.activePeerId;
        const startedAt = state.clocks.activeStartedAt;
        if (!activePeerId || !startedAt) return;
        const elapsed = Math.max(0, ts - startedAt);
        const clockKey = getClockKeyForPeer(ctx, activePeerId);
        state.clocks.remainingMsByPeerId[clockKey] = Math.max(
            0,
            (state.clocks.remainingMsByPeerId[clockKey] ?? 0) - elapsed
        );
        state.clocks.activeStartedAt = ts;
    }

    function grantIncrement(ctx, peerId) {
        const state = ctx.state;
        if (!state || !peerId) return;
        const increment = getClockSettingForPeer(ctx, peerId).incrementSeconds * 1000;
        const clockKey = getClockKeyForPeer(ctx, peerId);
        state.clocks.remainingMsByPeerId[clockKey] = (state.clocks.remainingMsByPeerId[clockKey] ?? 0) + increment;
    }

    function grantIncrementIfTurnPasses(ctx, actorPeerId, previousActorPeerId) {
        const state = ctx.state;
        if (!state || !actorPeerId || actorPeerId !== previousActorPeerId) return;
        const nextActorPeerId = phaseDescriptor(ctx).actorPeerId;
        if (nextActorPeerId && getClockKeyForPeer(ctx, nextActorPeerId) !== getClockKeyForPeer(ctx, actorPeerId)) {
            grantIncrement(ctx, actorPeerId);
        }
    }

    // Shared state mutation for the start/stop wrappers (no timer side effect).
    function setActiveClock(ctx, peerId, timestamp) {
        const state = ctx.state;
        if (!state || !peerId) return;
        state.status = 'playing';
        state.clocks.activePeerId = peerId;
        state.clocks.activeStartedAt = timestamp === undefined ? Date.now() : timestamp;
    }

    function clearActiveClock(ctx) {
        const state = ctx.state;
        if (!state) return;
        state.clocks.activePeerId = null;
        state.clocks.activeStartedAt = null;
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

        applyElapsedTime(ctx,timestamp);

        const color = getColorForPeer(ctx,peerId);
        const moveNumber = state.moves.length + 1;
        state.moves.push({
            x,
            y,
            color,
            peerId,
            number: moveNumber,
            ...(state.pairRenjuEnabled ? { pairTurnIndex: state.pairTurnIndex } : {}),
        });
        grantIncrement(ctx,peerId);
        advancePairTurn(ctx);

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

        applyElapsedTime(ctx,timestamp);
        const previousActorPeerId = descriptor.actorPeerId;
        if (shouldSwap) swapColors(ctx);
        advancePairTurn(ctx);

        if (state.phase === 'swap-after-1') setPhase(ctx, 'opening-move-2', timestamp);
        if (state.phase === 'swap-after-2') setPhase(ctx, 'opening-move-3', timestamp);
        if (state.phase === 'swap-after-3') setPhase(ctx, 'opening-move-4', timestamp);
        if (state.phase === 'swap-after-4') setPhase(ctx, 'opening-move-5-choice1', timestamp);
        if (state.phase === 'swap-after-5') setPhase(ctx, 'opening-move-6-choice1', timestamp);
        grantIncrementIfTurnPasses(ctx,peerId, previousActorPeerId);
        return '';
    }

    function chooseBranch(ctx, peerId, branch, timestamp) {
        const state = ctx.state;
        const descriptor = phaseDescriptor(ctx);
        if (state?.phase !== 'swap-after-4') return ctx.i18n('errCannotChoice');
        if (peerId !== descriptor.actorPeerId) return ctx.i18n('errOnlyBlackChoice');
        if (branch !== 'choice2') return '';

        applyElapsedTime(ctx,timestamp);
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

        applyElapsedTime(ctx,timestamp);
        const previousActorPeerId = descriptor.actorPeerId;
        state.opening.offeredMoves.push({ x, y });

        if (state.opening.offeredMoves.length >= 10) {
            advancePairTurn(ctx);
            setPhase(ctx, 'select-offer', timestamp);
        } else {
            setPhase(ctx, 'offering-choice2', timestamp);
        }
        grantIncrementIfTurnPasses(ctx,peerId, previousActorPeerId);
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

        applyElapsedTime(ctx,timestamp);
        const blackPeerId = getBlackPeerId(ctx);
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
        grantIncrementIfTurnPasses(ctx,peerId, previousActorPeerId);
        return '';
    }

    // Moves 1-6 are the opening: they must never be rewound. A takeback is
    // therefore allowed only while it leaves at least this many moves standing,
    // which in a normal game means black may take back from move 7 on and white
    // from move 8 on.
    const PROTECTED_MOVE_COUNT = 6;

    function isProposerTeamTurn(ctx, peerId) {
        const activePeerId = phaseDescriptor(ctx).actorPeerId;
        return getTeamForPeer(ctx,peerId) === getTeamForPeer(ctx,activePeerId);
    }

    // How many moves a takeback by peerId would remove; mirrors applyTakeback.
    function getTakebackMoveCount(ctx, peerId) {
        const state = ctx.state;
        const moves = state?.moves || [];
        if (!moves.length) return 0;
        if (state.pairRenjuEnabled) {
            return Math.min(isProposerTeamTurn(ctx, peerId) ? 2 : 1, moves.length);
        }
        let count = 1;
        while (count < moves.length && moves[moves.length - count - 1].peerId === peerId) count += 1;
        return count;
    }

    function getTakebackRequestError(ctx, peerId) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return ctx.i18n('errTakebackPlayingOnly');
        const participant = getParticipantById(ctx,peerId);
        if (!isSeatedParticipant(ctx,participant)) return ctx.i18n('errTakebackPlayerOnly');
        const remainingMoveCount = (state.moves || []).length - getTakebackMoveCount(ctx, peerId);
        if (remainingMoveCount < PROTECTED_MOVE_COUNT) return ctx.i18n('errTakebackTooEarly');
        const opponentPeerId = getOpponentPeerId(ctx,peerId);
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
            const proposerTeam = getTeamForPeer(ctx,peerId);
            const isOwnTeamTurn = isProposerTeamTurn(ctx, peerId);
            state.takebackMoveCount = getTakebackMoveCount(ctx, peerId);
            if (isOwnTeamTurn) {
                const opponentTeam = getOpponentTeam(proposerTeam);
                const lastOpponentMove = [...(state.moves || [])]
                    .reverse()
                    .find((move) => getTeamForPeer(ctx,move.peerId) === opponentTeam);
                state.takebackResponderPeerId = lastOpponentMove?.peerId || '';
            } else {
                state.takebackResponderPeerId = activePeerId;
            }
        } else {
            state.takebackMoveCount = 0;
            state.takebackResponderPeerId = getOpponentPeerId(ctx,peerId);
        }
        return '';
    }

    function applyTakeback(ctx, peerId, timestamp) {
        const state = ctx.state;
        if (!state || !state.moves?.length) return;
        applyElapsedTime(ctx,timestamp);
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
        const opponentPeerId = state.takebackResponderPeerId || getOpponentPeerId(ctx,offerPeerId);
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
        // Commit the active player's elapsed time before the clock stops, so the
        // displayed remaining doesn't rewind to its pre-turn value on finish.
        applyElapsedTime(ctx);
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
        resetReadyFlags(ctx);
        setPhase(ctx, 'finished');
        resetReviewMoves(ctx);
        // A completed game makes the next match a candidate for color alternation
        // (suppressed later if a player departs or someone swaps manually).
        state.swapColorsOnNextMatch = true;
    }

    function maybeStartMatch(ctx) {
        const state = ctx.state;
        if (!state || !['waiting-guest', 'finished'].includes(state.phase)
            || !allRequiredSeatsOccupied(ctx) || !allSeatedPlayersReady(ctx)) return;
        // From the 2nd game on, auto-alternate black/white vs the PREVIOUS GAME'S
        // STARTING colors (an in-game Swap can change seatColors mid-game, so we
        // must not derive this from the end state). Suppressed by departure/manual.
        const positionSetupEnabled = Boolean(state.positionSetupEnabled);
        const startMoves = positionSetupEnabled ? clonePositionMoves(state.moves) : [];
        const usePositionSetup = positionSetupEnabled && startMoves.length >= 6;
        const alternateColors = !usePositionSetup && state.phase === 'finished' && state.swapColorsOnNextMatch;
        clearBoardForNewMatch(ctx);
        if (usePositionSetup) state.moves = startMoves;
        ensureSeatColors(ctx);
        if (alternateColors && state.matchStartColors) {
            state.seatColors.black = state.matchStartColors.white;
            state.seatColors.white = state.matchStartColors.black;
            rebuildColors(ctx);
        }
        state.swapColorsOnNextMatch = false;
        // Snapshot the colors THIS match starts with, for the next alternation.
        state.matchStartColors = { black: state.seatColors.black, white: state.seatColors.white };
        resetReadyFlags(ctx);
        initializePairTurnOrder(ctx);
        if (usePositionSetup) {
            state.positionSetupActive = true;
            if (state.pairRenjuEnabled && state.pairTurnOrder.length) {
                state.pairTurnIndex = startMoves.length % state.pairTurnOrder.length;
            }
            setPhase(ctx, 'regular');
        } else {
            state.positionSetupActive = false;
            state.positionSetupAutoDisabled = positionSetupEnabled;
            setPhase(ctx, 'opening-move-1');
        }
        // Keep setup mode enabled after a setup-based match so it remains
        // visible when the match finishes. A short (<6 move) setup is the
        // explicit exception: it is automatically turned off for this start.
        state.positionSetupEnabled = usePositionSetup;
    }

    function setReadyState(ctx, peerId, ready) {
        const state = ctx.state;
        if (!state || !peerId) return ctx.i18n('errNotReadyState');
        const participant = getParticipantById(ctx,peerId);
        if (!isSeatedParticipant(ctx,participant)) return ctx.i18n('errReadyPlayerOnly');
        if (state.status === 'playing') return ctx.i18n('errReadyNotPlaying');
        state.readyByPeerId[peerId] = Boolean(ready);
        maybeStartMatch(ctx);
        return '';
    }

    function getDrawRequestError(ctx, peerId) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return ctx.i18n('errDrawPlayingOnly');
        const participant = getParticipantById(ctx,peerId);
        if (!isSeatedParticipant(ctx,participant)) return ctx.i18n('errDrawPlayerOnly');
        const descriptor = phaseDescriptor(ctx);
        if (
            state.pairRenjuEnabled
                ? getTeamForPeer(ctx,descriptor.actorPeerId) === getTeamForPeer(ctx,peerId)
                : descriptor.actorPeerId === peerId
        ) {
            return ctx.i18n('errDrawNotYourTurn');
        }
        const opponentPeerId = state.pairRenjuEnabled ? descriptor.actorPeerId : getOpponentPeerId(ctx,peerId);
        if (!opponentPeerId) return ctx.i18n('errDrawNoOpponent');
        if (state.pairRenjuEnabled && state.drawOfferByPeerId) return ctx.i18n('errDrawAlready');
        if (state.drawOfferByPeerId === peerId) return ctx.i18n('errDrawAlready');
        return '';
    }

    function offerDraw(ctx, peerId) {
        const state = ctx.state;
        const requestError = getDrawRequestError(ctx, peerId);
        if (requestError) return requestError;
        const opponentPeerId = state.pairRenjuEnabled ? phaseDescriptor(ctx).actorPeerId : getOpponentPeerId(ctx,peerId);
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
        const opponentPeerId = state.drawResponderPeerId || getOpponentPeerId(ctx,offerPeerId);
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
        const participant = getParticipantById(ctx,peerId);
        if (!isSeatedParticipant(ctx,participant)) return ctx.i18n('errResignPlayerOnly');
        if (state.pairRenjuEnabled) {
            finishGame(ctx, '', null, ctx.messageSpec('msgAgreedEndLog'));
            return '';
        }
        const opponentPeerId = getOpponentPeerId(ctx,peerId);
        finishGame(ctx, opponentPeerId, ctx.messageSpec('msgWin', ctx.getPeerName(opponentPeerId)), ctx.messageSpec('msgAgreedEndLog'));
        return '';
    }

    // ---- review board (post-game analysis) state ops (Step 2.2b) -----------
    // The shared analysis board after a game. Pure state mutations on
    // reviewMoves/reviewCursor/reviewBranchBaseCursor behind review-* intents.

    function canUseReviewBoard(ctx) {
        const state = ctx.state;
        return Boolean(state && state.status !== 'playing');
    }

    function getReviewBaseMoves(ctx) {
        const state = ctx.state;
        return state?.status === 'finished'
            ? (state.moves || []).map((move) => ({ ...move }))
            : [];
    }

    function resetReviewMoves(ctx) {
        const state = ctx.state;
        if (!state) return;
        state.reviewMoves = getReviewBaseMoves(ctx);
        state.reviewCursor = state.reviewMoves.length;
        state.reviewBranchBaseCursor = null;
    }

    function resetReviewMovesForPeer(ctx, peerId) {
        const state = ctx.state;
        if (!canUseReviewBoard(ctx)) return ctx.i18n('errReviewOnlyAfter');
        state.reviewMoves = getReviewBaseMoves(ctx);
        state.reviewCursor = state.reviewMoves.length;
        state.reviewBranchBaseCursor = null;
        return '';
    }

    function returnReviewToBranchBase(ctx, peerId) {
        const state = ctx.state;
        if (!canUseReviewBoard(ctx)) return ctx.i18n('errReviewOnlyAfter');
        if (!getParticipantById(ctx, peerId)) return ctx.i18n('errReviewOnlyParticipant');
        const currentCursor = state.reviewCursor ?? (state.reviewMoves || []).length;
        const hasBranch = state.reviewBranchBaseCursor != null;
        const base = hasBranch ? state.reviewBranchBaseCursor : currentCursor;
        const targetCursor = hasBranch && currentCursor > base ? base : currentCursor;
        state.reviewMoves = getReviewBaseMoves(ctx);
        state.reviewCursor = Math.max(0, Math.min(state.reviewMoves.length, targetCursor));
        state.reviewBranchBaseCursor = null;
        return '';
    }

    function addReviewMove(ctx, peerId, x, y) {
        const state = ctx.state;
        if (!canUseReviewBoard(ctx)) return ctx.i18n('errReviewOnlyAfter');
        if (!getParticipantById(ctx, peerId)) return ctx.i18n('errReviewOnlyParticipant');

        const cursor = state.reviewCursor ?? (state.reviewMoves || []).length;
        const currentMoves = (state.reviewMoves || []).slice(0, cursor);

        if (currentMoves.some((move) => move.x === x && move.y === y)) {
            return ctx.i18n('errReviewOccupied');
        }

        state.reviewMoves = currentMoves;
        // 分岐印 = 検討線が本譜と最初に食い違う手。走査せず差分で保つ。
        // 印より手前が本譜と一致することは定義が保証するので、cursor までの
        // 切り詰めで食い違いの元ごと消えた（印 >= cursor）なら印を降ろし、
        // 印が無いときだけ新しい手を本譜の同位置と比べれば足りる。分岐 →
        // 1手戻す → 本譜と同じ手、で本譜へ復帰した場合はここで印が降りる。
        // 本譜の終端より先に足す手は分岐（baseMove が undefined になる）。
        if (state.reviewBranchBaseCursor != null && state.reviewBranchBaseCursor >= cursor) {
            state.reviewBranchBaseCursor = null;
        }
        if (state.reviewBranchBaseCursor == null) {
            const baseMove = state.status === 'finished' ? (state.moves || [])[cursor] : undefined;
            const isOnMainLine = Boolean(baseMove) && baseMove.x === x && baseMove.y === y;
            if (!isOnMainLine) state.reviewBranchBaseCursor = cursor;
        }
        const nextColor = state.reviewMoves.length % 2 === 0 ? 'black' : 'white';
        state.reviewMoves.push({
            x,
            y,
            color: nextColor,
            peerId,
            number: state.reviewMoves.length + 1,
            review: true,
        });
        state.reviewCursor = state.reviewMoves.length;
        return '';
    }

    function setReviewCursor(ctx, peerId, cursor) {
        const state = ctx.state;
        if (!canUseReviewBoard(ctx)) return ctx.i18n('errReviewOnlyAfter');
        if (!getParticipantById(ctx, peerId)) return ctx.i18n('errReviewOnlyParticipant');
        const max = (state.reviewMoves || []).length;
        state.reviewCursor = Math.max(0, Math.min(max, cursor));
        return '';
    }

    // ---- room setup / seat / participant / admin / comment (Step 2.2a) -----
    // The remaining state mutations behind client intents, so the worker can
    // own them in Step 2.2. createInitialState runs before ctx.state exists, so
    // it takes a small deps object (i18n + createLogEntry) instead of ctx.

    function createInitialState(params, deps) {
        // hostId/hostToken are kept as param names for the creator's identity;
        // there is no host role anymore (the creator is just seated black).
        const { roomId, hostId, hostName, settings, hostToken = '' } = params;
        const initialMs = settings.baseSeconds * 1000;
        return {
            roomId,
            config: settings,
            pairRenjuEnabled: false,
            timeHandicapEnabled: false,
            // When true, the next match auto-swaps black/white (alternation).
            // Set on game end; cleared by a departure or a manual color swap.
            swapColorsOnNextMatch: false,
            positionSetupEnabled: false,
            positionSetupActive: false,
            positionSetupAutoDisabled: false,
            // seatColors snapshot at the START of the current match. Alternation
            // swaps from this (not the end state, which an in-game Swap can flip).
            matchStartColors: null,
            seatClockSettings: {
                black: { baseSeconds: settings.baseSeconds, incrementSeconds: settings.incrementSeconds },
                white: { baseSeconds: settings.baseSeconds, incrementSeconds: settings.incrementSeconds },
            },
            joinOrder: [hostId],
            participantsById: {
                [hostId]: { id: hostId, name: hostName, seat: 'black', token: hostToken },
            },
            seats: {
                black: hostId,
                white: null,
                blackBottom: null,
                whiteBottom: null,
            },
            readyByPeerId: {
                [hostId]: false,
            },
            seatColors: {
                black: 'black',
                white: 'white',
            },
            colorsByPeerId: { [hostId]: 'black' },
            moves: [],
            phase: 'waiting-guest',
            opening: {
                variant: null,
                offeredMoves: [],
            },
            clocks: {
                remainingMsByPeerId: { [hostId]: initialMs },
                activePeerId: null,
                activeStartedAt: null,
            },
            status: 'waiting',
            winnerId: null,
            resultText: '',
            resultMessage: null,
            drawOfferByPeerId: '',
            drawResponderPeerId: '',
            takebackOfferByPeerId: '',
            takebackResponderPeerId: '',
            takebackMoveCount: 0,
            pairTurnOrder: [],
            pairTurnIndex: 0,
            connectionPause: null,
            reviewMoves: [],
            reviewCursor: 0,
            reviewBranchBaseCursor: null,
            log: [deps.createLogEntry('presence', deps.i18n('msgJoined', hostName))],
            version: 0,
        };
    }

    function ensurePairRenjuState(ctx) {
        const state = ctx.state;
        if (!state) return;
        state.pairRenjuEnabled = Boolean(state.pairRenjuEnabled);
        state.positionSetupEnabled = Boolean(state.positionSetupEnabled);
        state.positionSetupActive = Boolean(state.positionSetupActive);
        state.positionSetupAutoDisabled = Boolean(state.positionSetupAutoDisabled);
        state.seats = state.seats || { black: null, white: null };
        if (!Object.prototype.hasOwnProperty.call(state.seats, 'blackBottom')) state.seats.blackBottom = null;
        if (!Object.prototype.hasOwnProperty.call(state.seats, 'whiteBottom')) state.seats.whiteBottom = null;
        if (!Array.isArray(state.pairTurnOrder)) state.pairTurnOrder = [];
        if (!Number.isInteger(state.pairTurnIndex)) state.pairTurnIndex = 0;
        if (typeof state.drawResponderPeerId !== 'string') state.drawResponderPeerId = '';
        if (typeof state.takebackResponderPeerId !== 'string') state.takebackResponderPeerId = '';
        if (!Number.isInteger(state.takebackMoveCount)) state.takebackMoveCount = 0;
    }

    function normalizeCommentText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    }

    function setPairRenjuEnabled(ctx, enabled) {
        const state = ctx.state;
        if (!state || state.status === 'playing') return;
        ensurePairRenjuState(ctx);
        const nextEnabled = Boolean(enabled);
        if (state.pairRenjuEnabled === nextEnabled) return;

        if (!nextEnabled) {
            for (const seat of ['blackBottom', 'whiteBottom']) {
                const peerId = state.seats[seat];
                const participant = getParticipantById(ctx, peerId);
                if (participant) participant.seat = 'spectator';
                if (peerId) state.readyByPeerId[peerId] = false;
                state.seats[seat] = null;
            }
        }

        state.pairRenjuEnabled = nextEnabled;
        // Only the match-setup structure changes here (seats / turn order /
        // ready / colours). The board (stones / result) is kept — like a seat
        // change after a finished game — so a post-game position survives the
        // toggle. maybeStartMatch -> clearBoardForNewMatch resets it when the
        // next game actually begins.
        state.pairTurnOrder = [];
        state.pairTurnIndex = 0;
        resetReadyFlags(ctx);
        rebuildColors(ctx);
    }

    function canSelfChangeSeat(ctx, peerId, nextSeat) {
        const state = ctx.state;
        if (!state || !peerId) return false;
        const participant = getParticipantById(ctx, peerId);
        if (!participant) return false;
        if (state.status === 'playing') return false;
        if (nextSeat === 'spectator') return true;
        if (!getActiveSeatKeys(ctx).includes(nextSeat)) return false;
        const occupant = state.seats[nextSeat];
        return !occupant || occupant === peerId;
    }

    function assignSeat(ctx, targetPeerId, nextSeat) {
        const state = ctx.state;
        if (!state) return ctx.i18n('errUnconnected');
        const participant = getParticipantById(ctx, targetPeerId);
        if (!participant) return '';
        if (nextSeat !== 'spectator' && !getActiveSeatKeys(ctx).includes(nextSeat)) return ctx.i18n('errInvalidSeat');

        const currentSeat = participant.seat || 'spectator';
        if (currentSeat === nextSeat) return '';
        if (isPlayingSeat(ctx, nextSeat)) {
            const occupantPeerId = state.seats[nextSeat];
            if (occupantPeerId && occupantPeerId !== targetPeerId) return ctx.i18n('errSeatOccupied');
        }

        const beforeSeatedIds = getActiveSeatKeys(ctx).map((seat) => state.seats[seat]).filter(Boolean);
        if (isPlayingSeat(ctx, currentSeat)) state.seats[currentSeat] = null;
        state.readyByPeerId[targetPeerId] = false;

        if (isPlayingSeat(ctx, nextSeat)) {
            state.seats[nextSeat] = targetPeerId;
        }

        participant.seat = nextSeat;
        rebuildColors(ctx);
        if (isPlayingSeat(ctx, nextSeat)) {
            syncSeatClockToParticipant(ctx, nextSeat);
        }
        ensureClockEntry(ctx, targetPeerId);
        const afterSeatedIds = getActiveSeatKeys(ctx).map((seat) => state.seats[seat]).filter(Boolean);
        const seatingChanged = beforeSeatedIds.join(':') !== afterSeatedIds.join(':');
        // A change to who occupies the playing seats means it's not the same pair
        // replaying: don't auto-alternate colors for the next game.
        if (seatingChanged) state.swapColorsOnNextMatch = false;

        if (
            state.status === 'playing'
            && nextSeat === 'spectator'
            && isPlayingSeat(ctx, currentSeat)
        ) {
            finishGame(ctx, '', null, ctx.messageSpec('msgAgreedEndLog'));
            state.swapColorsOnNextMatch = false; // departure mid-game: suppress next
            return '';
        }

        if (state.status === 'finished') {
            if (seatingChanged) resetReadyFlags(ctx);
            return '';
        }

        if (!allRequiredSeatsOccupied(ctx)) {
            state.phase = 'waiting-guest';
            state.status = 'waiting';
            ctx.stopClock();
            return '';
        }

        if (seatingChanged) {
            resetReadyFlags(ctx);
            state.phase = 'waiting-guest';
            state.status = 'waiting';
            ctx.stopClock();
        }
        return '';
    }

    function applyTimeSettings(ctx, settings) {
        const state = ctx.state;
        if (!state) return;
        state.timeHandicapEnabled = Boolean(settings.timeHandicapEnabled);
        state.seatClockSettings = { black: settings.black, white: settings.white };
        ensureSeatClockSettings(ctx);
        syncSeatClocksToParticipants(ctx);
        resetReadyFlags(ctx);
    }

    function removeParticipant(ctx, peerId, reasonText) {
        const state = ctx.state;
        if (!state || !peerId) return;
        const participant = getParticipantById(ctx, peerId);
        if (!participant) return;
        const wasSeated = isSeatedParticipant(ctx, participant);
        // A seated player leaving means the pair changed: suppress next-game
        // color alternation.
        if (wasSeated) state.swapColorsOnNextMatch = false;
        if (isPlayingSeat(ctx, participant.seat)) state.seats[participant.seat] = null;
        delete state.participantsById[peerId];
        delete state.colorsByPeerId[peerId];
        delete state.clocks.remainingMsByPeerId[peerId];
        delete state.readyByPeerId[peerId];
        if (Array.isArray(state.joinOrder)) {
            state.joinOrder = state.joinOrder.filter((id) => id !== peerId);
        }

        if (reasonText) ctx.addLog('system', reasonText);

        if (state.status === 'finished') {
            if (wasSeated) resetReadyFlags(ctx);
            return;
        }

        if (!allRequiredSeatsOccupied(ctx)) {
            state.phase = 'waiting-guest';
            state.status = 'waiting';
            ctx.stopClock();
        }
    }

    // Force every seated player to the spectator bench (non-playing only). The
    // board is left as-is; the next match clears it. Seating changed -> no
    // color alternation for the next game.
    function resetSeats(ctx) {
        const state = ctx.state;
        if (!state) return;
        for (const seat of ['black', 'white', 'blackBottom', 'whiteBottom']) {
            const peerId = state.seats[seat];
            if (!peerId) continue;
            const participant = getParticipantById(ctx, peerId);
            if (participant) participant.seat = 'spectator';
            state.readyByPeerId[peerId] = false;
            state.seats[seat] = null;
        }
        rebuildColors(ctx);
        state.swapColorsOnNextMatch = false;
        state.phase = 'waiting-guest';
        state.status = 'waiting';
        ctx.stopClock();
    }

    function addComment(ctx, peerId, text) {
        const state = ctx.state;
        if (!state) return ctx.i18n('errUnconnected');
        const participant = getParticipantById(ctx, peerId);
        if (!participant) return ctx.i18n('errUnconnected');
        const message = normalizeCommentText(text);
        if (!message) return ctx.i18n('errNeedComment');
        ctx.addLog('comment', `${participant.name}\n${message}`);
        return '';
    }

    function pauseMatchForDisconnect(ctx, peerId) {
        const state = ctx.state;
        if (!state || state.status !== 'playing') return;
        const activePeerId = state.clocks.activePeerId;
        applyElapsedTime(ctx);
        state.connectionPause = { peerId, activePeerId };
        ctx.stopClock();
    }

    function resumeMatchAfterReconnect(ctx) {
        const state = ctx.state;
        if (!state || state.status !== 'playing' || !state.connectionPause) return;
        if (hasDisconnectedSeatedPlayer(ctx)) return;
        const activePeerId = state.connectionPause.activePeerId || phaseDescriptor(ctx).actorPeerId;
        state.connectionPause = null;
        if (activePeerId) {
            ctx.startClockFor(activePeerId);
        }
    }

    root.GameCore = {
        getImplicitMovePhase,
        isInsideCenteredSquare,
        validateMoveConstraint,
        getShapeHash,
        phaseDescriptorBase,
        phaseDescriptor,
        // state / seat / color / turn helpers
        getParticipantById,
        isParticipantDisconnected,
        getActiveSeatKeys,
        isPlayingSeat,
        hasDisconnectedSeatedPlayer,
        getBlackPeerId,
        getWhitePeerId,
        getTeamForSeat,
        getSeatForPeer,
        getTeamForPeer,
        isSeatedParticipant,
        getOpponentTeam,
        getPairTurnActor,
        advancePairTurn,
        getColorForPeer,
        getOpponentPeerId,
        allRequiredSeatsOccupied,
        allSeatedPlayersReady,
        resetReadyFlags,
        // seat colors / seat-clock config / board reset
        normalizeClockSetting,
        ensureSeatColors,
        rebuildColors,
        ensureSeatClockSettings,
        syncSeatClockToParticipant,
        syncSeatClocksToParticipants,
        swapSeatColors,
        swapColors,
        clearBoardForNewMatch,
        initializePairTurnOrder,
        // pure clock state ops
        getClockSettingForPeer,
        getClockKeyForPeer,
        ensureClockEntry,
        applyElapsedTime,
        grantIncrement,
        grantIncrementIfTurnPasses,
        setActiveClock,
        clearActiveClock,
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
        // review board
        canUseReviewBoard,
        getReviewBaseMoves,
        resetReviewMoves,
        resetReviewMovesForPeer,
        returnReviewToBranchBase,
        addReviewMove,
        setReviewCursor,
        // room setup / seat / participant / admin / comment
        createInitialState,
        ensurePairRenjuState,
        normalizeCommentText,
        setPairRenjuEnabled,
        setPositionSetupEnabled,
        setPositionSetupStartMoves,
        canSelfChangeSeat,
        assignSeat,
        applyTimeSettings,
        removeParticipant,
        resetSeats,
        addComment,
        pauseMatchForDisconnect,
        resumeMatchAfterReconnect,
    };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
