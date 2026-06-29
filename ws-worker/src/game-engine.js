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
    // Presence (join / leave / disconnect / reconnect) is ephemeral: collected
    // into effects so the DO can broadcast a transient toast instead of letting
    // it pile up in the persistent chat log.
    notePresence: (messageKey, messageArg, by) => {
      if (!effects) return;
      if (!effects.presence) effects.presence = [];
      const entry = { messageKey, messageArg };
      if (by) entry.by = by; // actor token: clients skip their own change toast
      effects.presence.push(entry);
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
  const state = GameCore.createInitialState(
    { roomId, hostId: hostToken, hostName, settings, hostToken },
    {
      i18n: (key) => key,
      createLogEntry: (kind, text, options) => makeLogEntry(kind, text, options, now),
    }
  );
  // Presence is now ephemeral (toast), not logged; the creator joining alone
  // needs no entry. Start with an empty chat log.
  state.log = [];
  return state;
}

function dispatch(ctx, peerId, action, now) {
  const state = ctx.state;
  if (!state || !action) return '';
  const kind = action.kind;

  // A disconnected seated player no longer freezes play: the match keeps
  // running and the normal clock decides if they time out.

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
      // No host: anyone may change room settings while not playing. The change
      // is announced to others via an ephemeral toast (notePresence).
      if (state.status === 'playing') return ctx.i18n('errCannotSwap');
      GameCore.swapSeatColors(ctx);
      GameCore.resetReadyFlags(ctx);
      ctx.notePresence('msgColorsSwappedBy', ctx.getPeerName(peerId), peerId);
      return '';
    case 'pair-renju':
      if (state.status === 'playing') return ctx.i18n('errCannotSwap');
      GameCore.setPairRenjuEnabled(ctx, Boolean(action.enabled));
      ctx.notePresence(action.enabled ? 'msgPairRenjuOnBy' : 'msgPairRenjuOffBy', ctx.getPeerName(peerId), peerId);
      return '';
    case 'time-settings':
      if (state.status === 'playing') return ctx.i18n('errChangeTimePlaying');
      GameCore.applyTimeSettings(ctx, {
        timeHandicapEnabled: Boolean(action.timeHandicapEnabled),
        black: action.black,
        white: action.white,
      });
      ctx.notePresence('msgTimeChangedBy', ctx.getPeerName(peerId), peerId);
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

// Apply a clock timeout the DO's deadline alarm detected: the active player
// loses on time (draw in pair-renju). Mirrors the host's clock-timeout handler.
export function applyClockTimeout(state, options = {}) {
  const now = options.now ?? Date.now();
  const effects = {};
  const ctx = makeCtx(state, { now, effects });
  if (!state || state.status !== 'playing') return { applied: false, effects, state };
  const loserId = state.clocks.activePeerId;
  if (!loserId) return { applied: false, effects, state };
  GameCore.applyElapsedTime(ctx, now);
  const winnerId = state.pairRenjuEnabled ? '' : GameCore.getOpponentPeerId(ctx, loserId);
  GameCore.finishGame(
    ctx,
    winnerId,
    ctx.messageSpec('msgTimeout', ctx.getPeerName(loserId)),
    ctx.messageSpec('msgTimeoutLog')
  );
  state.version = (state.version || 0) + 1;
  return { applied: true, effects, state };
}

// ---- presence -> participant lifecycle (the DO drives this) -------------
// Mirrors the browser host's hello / close / bye reactions, mutating the
// authoritative state. The DO calls these from its presence machinery.

function markReconnectedInner(ctx, token, name) {
  const participant = GameCore.getParticipantById(ctx, token);
  if (!participant) return false;
  participant.name = name || participant.name;
  participant.token = token;
  // Reconnect simply un-greys the name; the match never paused, so there is
  // nothing to resume and no reconnect toast.
  delete participant.disconnectedAt;
  delete participant.disconnectedUntil;
  GameCore.ensureClockEntry(ctx, token);
  GameCore.rebuildColors(ctx);
  return true;
}

// A token said hello: reconnect an existing participant, or add a new
// spectator. Returns { effects, state, isNew }.
export function joinParticipant(state, token, name, options = {}) {
  const now = options.now ?? Date.now();
  const effects = {};
  const ctx = makeCtx(state, { now, effects });
  const existing = GameCore.getParticipantById(ctx, token);
  if (existing) {
    markReconnectedInner(ctx, token, name);
    return { effects, state, isNew: false };
  }
  state.participantsById[token] = { id: token, name, seat: 'spectator', token };
  if (!Array.isArray(state.joinOrder)) state.joinOrder = [];
  if (!state.joinOrder.includes(token)) state.joinOrder.push(token);
  GameCore.ensureClockEntry(ctx, token);
  ctx.notePresence('msgJoined', name);
  return { effects, state, isNew: true };
}

// A seated mid-game player is kept (not removed) so they can reconnect; we just
// mark them disconnected to grey the name. The match keeps running (no pause,
// no forfeit countdown, no toast) — the normal clock decides any time-out.
// Returns { preserved, effects, state }.
export function preserveDisconnected(state, token, options = {}) {
  const now = options.now ?? Date.now();
  const effects = {};
  const ctx = makeCtx(state, { now, effects });
  const participant = GameCore.getParticipantById(ctx, token);
  if (!participant) return { preserved: false, effects, state };
  const wasSeated = GameCore.isSeatedParticipant(ctx, participant);
  if (!wasSeated || state.status !== 'playing' || (state.moves || []).length === 0) {
    return { preserved: false, effects, state };
  }
  if (!participant.disconnectedAt) participant.disconnectedAt = now;
  return { preserved: true, effects, state };
}

// Fully remove a participant (used when not preserved). Emits an ephemeral
// "left" presence toast (not a log entry). Returns { effects, state }.
export function removeParticipant(state, token, options = {}) {
  const now = options.now ?? Date.now();
  const effects = {};
  const ctx = makeCtx(state, { now, effects });
  const participant = GameCore.getParticipantById(ctx, token);
  const name = participant?.name || '';
  GameCore.removeParticipant(ctx, token, ''); // no log text; toast below
  if (participant) ctx.notePresence('msgLeft', name);
  return { effects, state };
}

// At game end, fully remove any participant still greyed out (disconnectedAt
// set). Frees their seat for the next match. Emits "left" toasts and returns
// { removed: [tokens], effects, state }.
export function removeDisconnectedParticipants(state, options = {}) {
  const now = options.now ?? Date.now();
  const effects = {};
  const ctx = makeCtx(state, { now, effects });
  const tokens = Object.entries(state.participantsById || {})
    .filter(([, p]) => p && p.disconnectedAt)
    .map(([id]) => id);
  for (const token of tokens) {
    const name = state.participantsById[token]?.name || '';
    GameCore.removeParticipant(ctx, token, ''); // no log text; toast below
    ctx.notePresence('msgLeft', name);
  }
  return { removed: tokens, effects, state };
}
