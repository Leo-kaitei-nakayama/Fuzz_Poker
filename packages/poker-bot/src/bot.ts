import type { Action, GameState } from "@cute-poker/shared";
import { legalActions, toCall } from "@cute-poker/poker-engine";
import {
  hasDraw,
  madeHand,
  potSize,
  preflopTier,
  type PreflopTier,
} from "./handStrength.js";

export type Difficulty = "easy" | "normal";

export interface BotDecisionInput {
  readonly state: GameState;
  /** Seat of the bot that must act. Must equal state.toActSeat. */
  readonly seat: number;
  readonly difficulty: Difficulty;
  /** Injectable RNG in [0,1) for deterministic tests (default Math.random). */
  readonly rng?: () => number;
}

/**
 * Decide a bot action. ALWAYS returns an action that is legal in `state`
 * (SPEC §9.4: pure `(state, hole, position) -> action`). Never bluffs on
 * Normal; Easy is loose and passive so beginners win (SPEC §9.4.2).
 */
export function decideAction(input: BotDecisionInput): Action {
  const { state, seat, difficulty } = input;
  const rng = input.rng ?? Math.random;

  const la = legalActions(state);
  if (!la || la.seat !== seat) {
    throw new Error("decideAction called when it is not this seat's turn");
  }
  const hero = state.players.find((p) => p.seat === seat);
  if (!hero) throw new Error("bot seat not found");

  const need = toCall(state, hero);
  const pot = potSize(state);

  const ctx: Ctx = { state, seat, rng, la, hero, need, pot };
  return difficulty === "easy" ? decideEasy(ctx) : decideNormal(ctx);
}

interface Ctx {
  state: GameState;
  seat: number;
  rng: () => number;
  la: NonNullable<ReturnType<typeof legalActions>>;
  hero: GameState["players"][number];
  need: number;
  pot: number;
}

// --------------------------------------------------------------------------
// Easy: loose and passive. Calls a lot, rarely folds, bets small occasionally.
// --------------------------------------------------------------------------

function decideEasy(ctx: Ctx): Action {
  const { la, rng, state, hero } = ctx;
  const can = (t: Action["type"]) => la.types.includes(t);

  if (ctx.need === 0) {
    // No bet to face: mostly check, occasionally make a small bet.
    if (can("raise") && rng() < 0.25) {
      return raiseByPotFraction(ctx, 0.5);
    }
    return { type: "check" };
  }

  // Facing a bet. Easy folds only sometimes, and less with any made pair.
  const made =
    hero.holeCards.length === 2 && state.board.length >= 3
      ? madeHand(hero.holeCards, state.board)
      : null;
  const foldChance = made?.hasPair ? 0.1 : 0.35;
  if (can("fold") && rng() < foldChance && !isCheapCall(ctx)) {
    return { type: "fold" };
  }
  if (can("raise") && rng() < 0.12) {
    return raiseByPotFraction(ctx, 0.6);
  }
  return callOrAllInToMatch(ctx);
}

// --------------------------------------------------------------------------
// Normal: hand-range + pot-odds, no bluffing (SPEC §9.4.7).
// --------------------------------------------------------------------------

function decideNormal(ctx: Ctx): Action {
  return ctx.state.phase === "PREFLOP" ? normalPreflop(ctx) : normalPostflop(ctx);
}

function normalPreflop(ctx: Ctx): Action {
  const { hero, state, la } = ctx;
  const can = (t: Action["type"]) => la.types.includes(t);
  const tier = preflopTier(hero.holeCards);
  const late = isLatePosition(state, hero.seat);

  // Has anyone raised beyond the big blind?
  const facingRaise = state.currentBet > state.bb;

  if (!facingRaise) {
    // Unopened (or limped) pot: open-raise by strength & position.
    const openTiers: PreflopTier[] = late
      ? ["premium", "strong", "medium", "playable"]
      : ["premium", "strong", "medium"];
    if (can("raise") && openTiers.includes(tier)) {
      return raiseByPotFraction(ctx, 1.0); // ~pot-sized open (3-4bb)
    }
    if (ctx.need === 0) return { type: "check" }; // BB option, nothing to gain
    // Small blind / limp decision: call cheap with playable+, else fold.
    if (tier !== "trash" && isCheapCall(ctx)) return callOrAllInToMatch(ctx);
    return foldOrCheck(ctx);
  }

  // Facing a raise.
  if (can("raise") && (tier === "premium" || (tier === "strong" && ctx.rng() < 0.5))) {
    return raiseByPotFraction(ctx, 1.0); // 3-bet
  }
  if ((tier === "premium" || tier === "strong" || tier === "medium") && potOddsOk(ctx, 0.33)) {
    return callOrAllInToMatch(ctx);
  }
  if (tier === "playable" && isCheapCall(ctx)) return callOrAllInToMatch(ctx);
  return foldOrCheck(ctx);
}

function normalPostflop(ctx: Ctx): Action {
  const { hero, state, la } = ctx;
  const can = (t: Action["type"]) => la.types.includes(t);
  if (hero.holeCards.length !== 2) return foldOrCheck(ctx);

  const made = madeHand(hero.holeCards, state.board);
  const draw = hasDraw(hero.holeCards, state.board);

  if (ctx.need === 0) {
    // No bet to face.
    if (made.strong && can("raise")) return raiseByPotFraction(ctx, 0.66);
    if (draw && can("raise") && ctx.rng() < 0.5) return raiseByPotFraction(ctx, 0.5);
    return { type: "check" };
  }

  // Facing a bet.
  if (made.strong) {
    if (can("raise") && ctx.rng() < 0.5) return raiseByPotFraction(ctx, 0.66);
    return callOrAllInToMatch(ctx);
  }
  if (draw && potOddsOk(ctx, 0.3)) return callOrAllInToMatch(ctx);
  if (made.hasPair && potOddsOk(ctx, 0.2) && isCheapCall(ctx)) return callOrAllInToMatch(ctx);
  return foldOrCheck(ctx);
}

// --------------------------------------------------------------------------
// Action helpers — everything returned here is guaranteed legal.
// --------------------------------------------------------------------------

function foldOrCheck(ctx: Ctx): Action {
  if (ctx.need === 0) return { type: "check" };
  if (ctx.la.types.includes("fold")) return { type: "fold" };
  return { type: "check" };
}

/** Call the current bet; fall back to all-in when the call needs the stack. */
function callOrAllInToMatch(ctx: Ctx): Action {
  const { la } = ctx;
  if (ctx.need === 0) return la.types.includes("check") ? { type: "check" } : { type: "call" };
  if (la.types.includes("call")) return { type: "call" };
  if (la.types.includes("allin")) return { type: "allin" };
  return foldOrCheck(ctx);
}

/**
 * Raise to a size based on a fraction of the pot after calling. Clamps into the
 * legal [min, max] range; if we cannot make a legal raise, fall back to a call.
 */
function raiseByPotFraction(ctx: Ctx, fraction: number): Action {
  const bounds = ctx.la.raise;
  if (!bounds || bounds.max < bounds.min) {
    // Can only shove (short) or just call.
    if (ctx.la.types.includes("allin") && ctx.rng() < 0.5) return { type: "allin" };
    return callOrAllInToMatch(ctx);
  }
  const potAfterCall = ctx.pot + ctx.need;
  const desiredIncrement = Math.max(ctx.state.bb, Math.round(potAfterCall * fraction));
  let to = ctx.state.currentBet + desiredIncrement;
  to = Math.max(bounds.min, Math.min(bounds.max, to));
  return { type: "raise", amount: to };
}

/** Pot odds are acceptable when the call is no more than `max` of the pot. */
function potOddsOk(ctx: Ctx, max: number): boolean {
  if (ctx.need === 0) return true;
  const odds = ctx.need / (ctx.pot + ctx.need);
  return odds <= max;
}

/** A "cheap" call is small relative to the bot's stack and the pot. */
function isCheapCall(ctx: Ctx): boolean {
  const callAmt = Math.min(ctx.need, ctx.hero.stack);
  return callAmt <= ctx.state.bb * 2 || callAmt <= ctx.hero.stack * 0.05;
}

/** Is this seat in late position (button or cutoff) among in-hand players? */
function isLatePosition(state: GameState, seat: number): boolean {
  const inHand = state.players.filter((p) => p.inHand).sort((a, b) => a.seat - b.seat);
  if (inHand.length <= 3) return true; // short-handed: play most seats as "late"
  const btnIdx = inHand.findIndex((p) => p.seat === state.buttonSeat);
  const heroIdx = inHand.findIndex((p) => p.seat === seat);
  const fromButton = (heroIdx - btnIdx + inHand.length) % inHand.length;
  // 0 = button, inHand.length-1 = cutoff.
  return fromButton === 0 || fromButton === inHand.length - 1;
}
