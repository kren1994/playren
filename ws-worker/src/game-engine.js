// Worker-side game engine. Applies client intents to the authoritative room
// state using the shared, UI-free game-core. This module is pure and
// deterministic (no Durable Object / IO / timers), so it can be unit-tested in
// Node. The Durable Object wires it in (presence, persistence, broadcast,
// alarm-based clock timeout) in Step 2.2c.
//
// The browser host applied the same game-core via gameCoreCtx(); here we build
// the equivalent worker ctx: i18n returns the message CODE (clients localize),
// logs carry messageKey/messageArg, and startClockFor/stopClock record a clock
// "effect" for the DO to translate into its authoritative deadline timer.
import '../../game-core.js'; // side-effect: sets globalThis.GameCore

const GameCore = globalThis.GameCore;

const CENTER = 7;
const MAX_LOG_ITEMS = 64; // mirror index.html

function nowIsoTime(now) {
  // HH:MM:SS, mirroring the browser's display-time field. Clients may re-render.
  return new Date(now).toISOString().slice(11, 19);
}

function makeLogEntry(kind, text, options = {}, now = Date.now()) {
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text,
    time: nowIsoTime(now),
    ...(options.action ? { action: options.action } : {}),
    ...(options.messageKey ? { messageKey: options.messageKey } : {}),
    ...(Object.prototype.hasOwnProperty.call(options, 'messageArg') ? { messageArg: options.messageArg } : {}),
    ...(options.moves ? { moves: options.moves } : {}),
  };
}

// Seated player tokens whose presence gates the clock (all active seats).
function activeSeatTokens(ctx) {
  const state = ctx.state;
  return GameCore.getActiveSeatKeys(ctx)
    .map((seat) => state.seats?.[seat])
    .filter(Boolean);
}

// Build the worker-side ctx. `effects.clock` captures the desired authoritative
// clock state so the DO can arm/disarm its deadline timer after applying.
export function makeCtx(state, { now = Date.now(), effects } = {}) {
  const ctx = {
    state,
    center: CENTER,
    // worker returns the message CODE; clients localize from messageKey/arg
    i18n: (key) => key,
    messageSpec: function messageSpec(key, arg) {
      return arguments.length > 1 ? { key, arg } : { key };
    },
    renderMessageSpec: () => '', // clients render result/log text from the spec
    getPeerName: (id) => state.participantsById?.[id]?.name || id,
    resetDisplayMoveCount: () => {}, // client-only UI concern
    addLog: (kind, text, options = {}) => {
      if (!Array.isArray(state.log)) state.log = [];
      state.log.unshift(makeLogEntry(kind, text, options, now));
      state.log = state.log.slice(0, MAX_LOG_ITEMS);
    },
    startClockFor: (peerId, ts) => {
      if (!state || !peerId) {
        ctx.stopClock();
        return;
      }
      GameCore.setActiveClock(ctx, peerId, ts === undefined ? now : ts);
      if (effects) {
        const clockKey = GameCore.getClockKeyForPeer(ctx, peerId);
        effects.clock = {
          armed: true,
          peerId,
          remainingMs: Math.max(0, state.clocks.remainingMsByPeerId[clockKey] ?? 0),
          gateTokens: activeSeatTokens(ctx),
        };
      }
    },
    stopClock: () => {
      if (!state) return;
      GameCore.clearActiveClock(ctx);
      if (effects) effects.clock = { armed: false };
    },
  };
  return ctx;
}

export function createRoom({ roomId, hostToken, hostName, settings, now = Date.now() }) {
  return GameCore.createInitialState(
    { roomId, hostId: hostToken, hostName, settings, hostToken },
    {
      i18n: (key) => key,
      createLogEntry: (kind, text, options) => makeLogEntry(kind, text, options, now),
    }
  );
}

// Intents that must not be applied while a seated player is mid-disconnect
// (the match is paused). Mirrors the browser's pausedBlockedActions.
const PAUSE_BLOCKED = new Set([
  'move', 'swap', 'choice2', 'draw', 'draw-response', 'takeback',
  'takeback-response', 'resign', 'offer', 'select-offer', 'ready',
]);

function dispatch(ctx, peerId, action, now) {
  const state = ctx.state;
  if (!state || !action) return '';
  const kind = action.kind;

  if (GameCore.hasDisconnectedSeatedPlayer(ctx) && PAUSE_BLOCKED.has(kind)) {
    return ctx.i18n('errMatchPausedForDisconnect');
  }

  switch (kind) {
    case 'move': return GameCore.placeMove(ctx, peerId, action.x, action.y, now);
    case 'swap': return GameCore.resolveSwap(ctx, peerId, true, now);
    case 'choice2': return GameCore.chooseBranch(ctx, peerId, 'choice2', now);
    case 'offer': return GameCore.offerMove(ctx, peerId, action.x, action.y, now);
    case 'select-offer': return GameCore.selectOfferedMove(ctx, peerId, action.x, action.y, now);
    case 'draw': return GameCore.offerDraw(ctx, peerId);
    case 'draw-response': return GameCore.respondDraw(ctx, peerId, Boolean(action.accept));
    case 'takeback': return GameCore.requestTakeback(ctx, peerId);
    case 'takeback-response': return GameCore.respondTakeback(ctx, peerId, Boolean(action.accept));
    case 'resign': return GameCore.resignGame(ctx, peerId);
    case 'ready': return GameCore.setReadyState(ctx, peerId, Boolean(action.ready));
    case 'comment': return GameCore.addComment(ctx, peerId, action.text);
    case 'review-move': return GameCore.addReviewMove(ctx, peerId, action.x, action.y);
    case 'review-cursor': return GameCore.setReviewCursor(ctx, peerId, action.cursor);
    case 'review-undo':
      return GameCore.setReviewCursor(ctx, peerId, (state.reviewCursor ?? (state.reviewMoves || []).length) - 1);
    case 'review-reset': return GameCore.resetReviewMovesForPeer(ctx, peerId);
    case 'review-branch-base': return GameCore.returnReviewToBranchBase(ctx, peerId);
    case 'swap-seat-colors':
      if (peerId !== state.hostPeerId) return ctx.i18n('errUnconnected');
      if (state.status === 'playing') return ctx.i18n('errCannotSwap');
      GameCore.swapSeatColors(ctx);
      GameCore.resetReadyFlags(ctx);
      return '';
    case 'pair-renju':
      if (peerId !== state.hostPeerId) return ctx.i18n('errUnconnected');
      if (state.status === 'playing') return ctx.i18n('errCannotSwap');
      GameCore.setPairRenjuEnabled(ctx, Boolean(action.enabled));
      return '';
    case 'seat-change': {
      const isSelf = action.targetPeerId === peerId && GameCore.canSelfChangeSeat(ctx, peerId, action.seat);
      if (!isSelf) return ctx.i18n('errOnlyEmptySeat');
      return GameCore.assignSeat(ctx, action.targetPeerId, action.seat);
    }
    default:
      return '';
  }
}

// Apply one intent from `actorToken`. Returns { error, effects, changed }.
// `error` is a message CODE ('' = success). `effects.clock` (if present) tells
// the DO how to arm/disarm its authoritative deadline timer. On success the
// authoritative state.version is bumped so the DO can version its broadcast.
export function applyIntent(state, actorToken, intent, options = {}) {
  const now = options.now ?? Date.now();
  const effects = {};
  const ctx = makeCtx(state, { now, effects });
  const error = dispatch(ctx, actorToken, intent, now) || '';
  const changed = !error;
  if (changed) {
    state.version = (state.version || 0) + 1;
  }
  return { error, effects, changed, state };
}

// Presence helpers (the DO drives connect/disconnect/leave; these mutate the
// authoritative state the same way the browser host did).
export function pauseForDisconnect(state, peerId, options = {}) {
  const ctx = makeCtx(state, { now: options.now ?? Date.now() });
  GameCore.pauseMatchForDisconnect(ctx, peerId);
  return state;
}

export function resumeAfterReconnect(state, options = {}) {
  const effects = {};
  const ctx = makeCtx(state, { now: options.now ?? Date.now(), effects });
  GameCore.resumeMatchAfterReconnect(ctx);
  return { effects, state };
}

export function removeParticipant(state, peerId, reasonText, options = {}) {
  const ctx = makeCtx(state, { now: options.now ?? Date.now() });
  GameCore.removeParticipant(ctx, peerId, reasonText);
  return state;
}
