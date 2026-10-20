import type { Action, Card, GameState, PlayerState, PotResult } from "@cute-poker/shared";
import { cryptoRandInt, shuffledDeck, type RandInt } from "./deck.js";
import { evaluateBest, type HandValue } from "./evaluator.js";
import {
  hasCallableOpponent,
  isActive,
  isLegalRaiseTo,
  legalActionTypes,
  needsToAct,
  raiseBounds,
  toCall,
  type RaiseBounds,
} from "./betting.js";
import { awardPots, buildSidePots, type Contribution } from "./pots.js";

/** Mutable interior mirror of PlayerState used while applying a transition. */
interface MPlayer {
  id: string;
  seat: number;
  stack: number;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  committed: number;
  streetCommitted: number;
  hasActed: boolean;
  sittingOut: boolean;
  inHand: boolean;
}

interface MState {
  phase: GameState["phase"];
  handNumber: number;
  sb: number;
  bb: number;
  players: MPlayer[];
  buttonSeat: number;
  deck: Card[];
  board: Card[];
  currentBet: number;
  lastRaiseSize: number;
  toActSeat: number | null;
  lastAggressorSeat: number | null;
  results: PotResult[];
}

export interface SeatConfig {
  readonly id: string;
  readonly seat: number;
  readonly stack: number;
  readonly sittingOut?: boolean;
}

export interface StartHandOptions {
  readonly players: readonly SeatConfig[];
  readonly buttonSeat: number;
  readonly sb: number;
  readonly bb: number;
  readonly handNumber: number;
  /** Pre-arranged deck (for deterministic tests). Dealt from the front. */
  readonly deck?: readonly Card[];
  readonly randInt?: RandInt;
}

// --------------------------------------------------------------------------
// Seat ordering helpers
// --------------------------------------------------------------------------

/** Players ordered starting just AFTER `seat`, wrapping; the seat sits last. */
function rotateFrom<T extends { seat: number }>(players: readonly T[], seat: number): T[] {
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const after = sorted.filter((p) => p.seat > seat);
  const before = sorted.filter((p) => p.seat <= seat);
  return [...after, ...before];
}

function firstMatchingFrom<T extends { seat: number }>(
  players: readonly T[],
  seat: number,
  pred: (p: T) => boolean,
): T | null {
  return rotateFrom(players, seat).find(pred) ?? null;
}

// --------------------------------------------------------------------------
// Start a hand
// --------------------------------------------------------------------------

export function startHand(opts: StartHandOptions): GameState {
  const randInt = opts.randInt ?? cryptoRandInt;
  const deck: Card[] = opts.deck ? [...opts.deck] : shuffledDeck(randInt);

  const players: MPlayer[] = opts.players
    .map((c) => ({
      id: c.id,
      seat: c.seat,
      stack: c.stack,
      holeCards: [] as Card[],
      folded: false,
      allIn: false,
      committed: 0,
      streetCommitted: 0,
      hasActed: false,
      sittingOut: c.sittingOut ?? false,
      inHand: c.stack > 0 && !(c.sittingOut ?? false),
    }))
    .sort((a, b) => a.seat - b.seat);

  const inHand = players.filter((p) => p.inHand);
  if (inHand.length < 2) {
    throw new Error("Need at least 2 funded, seated players to start a hand");
  }
  if (!inHand.some((p) => p.seat === opts.buttonSeat)) {
    throw new Error("buttonSeat must be an in-hand player's seat");
  }

  const isHeadsUp = inHand.length === 2;
  const buttonPlayer = inHand.find((p) => p.seat === opts.buttonSeat)!;
  const afterButton = rotateFrom(inHand, opts.buttonSeat);

  const sbPlayer = isHeadsUp ? buttonPlayer : afterButton[0]!;
  const bbPlayer = isHeadsUp ? afterButton[0]! : afterButton[1]!;

  const m: MState = {
    phase: "PREFLOP",
    handNumber: opts.handNumber,
    sb: opts.sb,
    bb: opts.bb,
    players,
    buttonSeat: opts.buttonSeat,
    deck,
    board: [],
    currentBet: opts.bb,
    lastRaiseSize: opts.bb,
    toActSeat: null,
    lastAggressorSeat: bbPlayer.seat,
    results: [],
  };

  postBlind(sbPlayer, opts.sb);
  postBlind(bbPlayer, opts.bb);

  // Deal two hole cards to each in-hand player, starting from the SB.
  const dealOrder = rotateFrom(inHand, opts.buttonSeat); // SB-ward (HU: button first, fine)
  for (let round = 0; round < 2; round++) {
    for (const p of dealOrder) {
      p.holeCards.push(deck.shift()!);
    }
  }

  // Preflop first to act: UTG (seat after BB), or the button in heads-up.
  const firstToAct = isHeadsUp
    ? buttonPlayer
    : firstMatchingFrom(inHand, bbPlayer.seat, (p) => isActive(p));
  m.toActSeat = firstToAct ? firstToAct.seat : null;

  // If no one can act (both blinds all-in), run it out immediately.
  if (m.toActSeat === null || !m.players.some((p) => needsToAct(freezeState(m), p))) {
    return resolveAfterRoundCheck(m);
  }

  return freezeState(m);
}

function postBlind(p: MPlayer, amount: number): void {
  const paid = Math.min(amount, p.stack);
  p.stack -= paid;
  p.committed += paid;
  p.streetCommitted += paid;
  if (p.stack === 0) p.allIn = true;
  // Posting a blind is not "acting": the big blind keeps its preflop option.
}

// --------------------------------------------------------------------------
// Legal actions (convenience for server / bot / UI)
// --------------------------------------------------------------------------

export interface LegalActions {
  readonly seat: number;
  readonly types: ReturnType<typeof legalActionTypes>;
  readonly callAmount: number;
  readonly raise: RaiseBounds | null;
}

export function legalActions(state: GameState): LegalActions | null {
  if (state.toActSeat === null) return null;
  const p = state.players.find((x) => x.seat === state.toActSeat);
  if (!p) return null;
  return {
    seat: p.seat,
    types: legalActionTypes(state, p),
    callAmount: Math.min(toCall(state, p), p.stack),
    raise: p.hasActed || !hasCallableOpponent(state, p) ? null : raiseBounds(state, p),
  };
}

// --------------------------------------------------------------------------
// Apply an action
// --------------------------------------------------------------------------

export function applyAction(state: GameState, action: Action): GameState {
  if (state.toActSeat === null) {
    throw new Error("No action is pending in the current state");
  }
  const m = thawState(state);
  const p = m.players.find((x) => x.seat === m.toActSeat);
  if (!p) throw new Error("Active seat not found");

  const actedSeat = p.seat;
  const need = toCall(freezeState(m), p);

  switch (action.type) {
    case "fold":
      p.folded = true;
      p.hasActed = true;
      break;

    case "check":
      if (need !== 0) throw new Error("Cannot check facing a bet");
      p.hasActed = true;
      break;

    case "call": {
      if (need === 0) throw new Error("Nothing to call; use check");
      const pay = Math.min(need, p.stack);
      commit(p, pay);
      p.hasActed = true;
      break;
    }

    case "raise": {
      if (action.amount === undefined) throw new Error("raise requires an amount");
      if (!isLegalRaiseTo(freezeState(m), p, action.amount)) {
        throw new Error(`Illegal raise to ${action.amount}`);
      }
      applyAggression(m, p, action.amount);
      break;
    }

    case "allin": {
      if (p.stack <= 0) throw new Error("No chips to go all-in");
      const target = p.streetCommitted + p.stack;
      const canReopen = !p.hasActed && hasCallableOpponent(freezeState(m), p);
      if (target > m.currentBet && canReopen) {
        applyAggression(m, p, target);
      } else {
        // All-in call (or an all-in that cannot reopen betting).
        commit(p, p.stack);
        p.hasActed = true;
      }
      break;
    }

    default:
      throw new Error(`Unknown action type: ${(action as Action).type}`);
  }

  return resolve(m, actedSeat);
}

function commit(p: MPlayer, amount: number): void {
  p.stack -= amount;
  p.committed += amount;
  p.streetCommitted += amount;
  if (p.stack === 0) p.allIn = true;
}

/** Apply a bet/raise/all-in to `targetTo` (a street-committed total). */
function applyAggression(m: MState, p: MPlayer, targetTo: number): void {
  const added = targetTo - p.streetCommitted;
  commit(p, added);
  p.hasActed = true;

  if (targetTo > m.currentBet) {
    const increment = targetTo - m.currentBet;
    const isFullRaise = increment >= m.lastRaiseSize;
    m.currentBet = targetTo;
    m.lastAggressorSeat = p.seat;
    if (isFullRaise) {
      m.lastRaiseSize = increment;
      // A full raise reopens betting: everyone else active must act again.
      for (const q of m.players) {
        if (q.id !== p.id && isActive(q)) q.hasActed = false;
      }
    }
    // Short all-in: currentBet rises but lastRaiseSize and others' hasActed
    // are left untouched, so no one gets fresh re-raise rights (SPEC §9.2).
  }
}

// --------------------------------------------------------------------------
// Resolution: advance to the next actor, next street, or hand end
// --------------------------------------------------------------------------

function resolve(m: MState, actedSeat: number): GameState {
  const contenders = m.players.filter((p) => p.inHand && !p.folded);
  if (contenders.length <= 1) return settleUncontested(m);

  if (bettingRoundComplete(m)) return advanceStreet(m);

  const next = firstMatchingFrom(m.players, actedSeat, (p) => needsToAct(freezeState(m), p));
  m.toActSeat = next ? next.seat : null;
  return freezeState(m);
}

/** Used right after start when blinds may have ended the action. */
function resolveAfterRoundCheck(m: MState): GameState {
  const contenders = m.players.filter((p) => p.inHand && !p.folded);
  if (contenders.length <= 1) return settleUncontested(m);
  if (bettingRoundComplete(m)) return advanceStreet(m);
  return freezeState(m);
}

function bettingRoundComplete(m: MState): boolean {
  const frozen = freezeState(m);
  const contenders = m.players.filter((p) => p.inHand && !p.folded);
  if (contenders.length <= 1) return true;
  const actors = contenders.filter((p) => !p.allIn);
  if (actors.length === 0) return true;
  // Only one player can still wager: round ends once they have matched the bet.
  if (actors.length === 1) return actors[0]!.streetCommitted >= m.currentBet;
  return !actors.some((p) => needsToAct(frozen, p));
}

function advanceStreet(m: MState): GameState {
  // Close the current street.
  for (const p of m.players) {
    p.streetCommitted = 0;
    p.hasActed = false;
  }
  m.currentBet = 0;
  m.lastRaiseSize = m.bb;
  m.lastAggressorSeat = null;

  const nextPhase = nextStreet(m.phase);
  if (nextPhase === "SHOWDOWN") {
    return settleShowdown(m);
  }

  // Deal the board for the new street.
  if (nextPhase === "FLOP") {
    m.board.push(m.deck.shift()!, m.deck.shift()!, m.deck.shift()!);
  } else {
    m.board.push(m.deck.shift()!);
  }
  m.phase = nextPhase;

  // If fewer than two players still have chips, no betting is possible this
  // street (at street start there is no bet to call), so run out the board to
  // showdown. Any uncalled chips are returned as a side pot there.
  const activeCount = m.players.filter((p) => isActive(p)).length;
  if (activeCount <= 1) {
    return advanceStreet(m);
  }

  // Postflop first to act: first active player left of the button.
  const first = firstMatchingFrom(m.players, m.buttonSeat, (p) => isActive(p))!;
  m.toActSeat = first.seat;
  return freezeState(m);
}

function nextStreet(phase: GameState["phase"]): GameState["phase"] {
  switch (phase) {
    case "PREFLOP":
      return "FLOP";
    case "FLOP":
      return "TURN";
    case "TURN":
      return "RIVER";
    case "RIVER":
      return "SHOWDOWN";
    default:
      throw new Error(`Cannot advance street from phase ${phase}`);
  }
}

// --------------------------------------------------------------------------
// Settlement
// --------------------------------------------------------------------------

function settleShowdown(m: MState): GameState {
  const contenders = m.players.filter((p) => p.inHand && !p.folded);

  const values: Record<string, HandValue> = {};
  for (const p of contenders) {
    values[p.id] = evaluateBest([...p.holeCards, ...m.board]);
  }

  const contributions: Contribution[] = m.players
    .filter((p) => p.committed > 0)
    .map((p) => ({ id: p.id, committed: p.committed, folded: p.folded }));

  const pots = buildSidePots(contributions);

  // Odd-chip remainders go to the earliest position left of the button.
  const positionOrder = rotateFrom(contenders, m.buttonSeat).map((p) => p.id);

  const awards = awardPots(pots, values, positionOrder);

  applyAwards(m, awards);
  clearPot(m);
  m.phase = "HAND_END";
  m.toActSeat = null;
  return freezeState(m);
}

function settleUncontested(m: MState): GameState {
  const winner = m.players.find((p) => p.inHand && !p.folded);
  const total = m.players.reduce((sum, p) => sum + p.committed, 0);
  if (winner) {
    winner.stack += total;
    m.results = [
      {
        amount: total,
        winners: [winner.id],
        payouts: { [winner.id]: total },
        eligible: [winner.id],
      },
    ];
  }
  clearPot(m);
  m.phase = "HAND_END";
  m.toActSeat = null;
  return freezeState(m);
}

function applyAwards(m: MState, awards: ReturnType<typeof awardPots>): void {
  const byId = new Map(m.players.map((p) => [p.id, p]));
  const results: PotResult[] = [];
  for (const a of awards) {
    for (const [id, chips] of Object.entries(a.payouts)) {
      const p = byId.get(id);
      if (p) p.stack += chips;
    }
    results.push({
      amount: a.amount,
      winners: a.winners,
      payouts: a.payouts,
      eligible: a.eligible,
    });
  }
  m.results = results;
}

/** Chips have left the pot and been credited to winners' stacks. */
function clearPot(m: MState): void {
  for (const p of m.players) {
    p.committed = 0;
    p.streetCommitted = 0;
  }
}

// --------------------------------------------------------------------------
// freeze / thaw between the public readonly GameState and the mutable interior
// --------------------------------------------------------------------------

function freezeState(m: MState): GameState {
  const players: PlayerState[] = m.players.map((p) => ({
    id: p.id,
    seat: p.seat,
    stack: p.stack,
    holeCards: [...p.holeCards],
    folded: p.folded,
    allIn: p.allIn,
    committed: p.committed,
    streetCommitted: p.streetCommitted,
    hasActed: p.hasActed,
    sittingOut: p.sittingOut,
    inHand: p.inHand,
  }));
  return {
    phase: m.phase,
    handNumber: m.handNumber,
    sb: m.sb,
    bb: m.bb,
    players,
    buttonSeat: m.buttonSeat,
    deck: [...m.deck],
    board: [...m.board],
    currentBet: m.currentBet,
    lastRaiseSize: m.lastRaiseSize,
    toActSeat: m.toActSeat,
    lastAggressorSeat: m.lastAggressorSeat,
    results: m.results.map((r) => ({ ...r, payouts: { ...r.payouts } })),
  };
}

function thawState(state: GameState): MState {
  return {
    phase: state.phase,
    handNumber: state.handNumber,
    sb: state.sb,
    bb: state.bb,
    players: state.players.map((p) => ({
      id: p.id,
      seat: p.seat,
      stack: p.stack,
      holeCards: [...p.holeCards],
      folded: p.folded,
      allIn: p.allIn,
      committed: p.committed,
      streetCommitted: p.streetCommitted,
      hasActed: p.hasActed,
      sittingOut: p.sittingOut,
      inHand: p.inHand,
    })),
    buttonSeat: state.buttonSeat,
    deck: [...state.deck],
    board: [...state.board],
    currentBet: state.currentBet,
    lastRaiseSize: state.lastRaiseSize,
    toActSeat: state.toActSeat,
    lastAggressorSeat: state.lastAggressorSeat,
    results: state.results.map((r) => ({ ...r, payouts: { ...r.payouts } })),
  };
}

/** Total chips across every stack plus chips still committed to the pot. */
export function totalChips(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.stack + p.committed, 0);
}

/** Convenience: is the hand finished? */
export function isHandOver(state: GameState): boolean {
  return state.phase === "HAND_END";
}
