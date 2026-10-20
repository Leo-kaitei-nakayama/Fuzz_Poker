import type { ActionType, GameState, PlayerState } from "@cute-poker/shared";

/** Is this player still able to take betting actions? */
export function isActive(p: PlayerState): boolean {
  return p.inHand && !p.folded && !p.allIn;
}

/**
 * Does the player have at least one opponent who could still call a bet? When
 * everyone else is all-in or folded there is no one to call, so betting is
 * closed — the player may only check/call/fold, never bet or raise.
 */
export function hasCallableOpponent(state: GameState, p: PlayerState): boolean {
  return state.players.some((q) => q.id !== p.id && isActive(q));
}

/** Chips this player must add to match the current bet. */
export function toCall(state: GameState, p: PlayerState): number {
  return Math.max(0, state.currentBet - p.streetCommitted);
}

export interface RaiseBounds {
  /** Minimum legal raise-to total (street-committed). */
  readonly min: number;
  /** Maximum legal raise-to total (all-in). */
  readonly max: number;
}

/**
 * The legal raise-to bounds for a player, or null if they cannot raise at all
 * (no chips beyond a call). `max` may be below `min` when the player can only
 * move all-in for less than a full raise (a short all-in).
 */
export function raiseBounds(state: GameState, p: PlayerState): RaiseBounds | null {
  const max = p.streetCommitted + p.stack;
  if (max <= state.currentBet) return null; // cannot even exceed current bet
  const min =
    state.currentBet === 0
      ? Math.max(state.bb, state.lastRaiseSize)
      : state.currentBet + state.lastRaiseSize;
  return { min, max };
}

/** Which action types are legal for the player whose turn it is. */
export function legalActionTypes(state: GameState, p: PlayerState): ActionType[] {
  const types: ActionType[] = [];
  const need = toCall(state, p);

  // Fold is always available (even when checking is free — the player may
  // still choose to fold; the UI usually hides it, but it is legal).
  types.push("fold");

  if (need === 0) {
    types.push("check");
  } else {
    types.push("call");
  }

  // A raise is only offered when the player still has the right to reopen
  // betting. A full raise resets everyone's `hasActed`; a short all-in does
  // not — so `hasActed === true` while facing a bet means the player is looking
  // at a sub-full all-in and may only call or fold (SPEC §9.2).
  const bounds = raiseBounds(state, p);
  if (bounds && p.stack > need && !p.hasActed && hasCallableOpponent(state, p)) {
    types.push("raise");
  }

  // All-in is only a distinct, useful option while an opponent can still call;
  // otherwise the player simply checks or calls (no uncalled chips committed).
  if (p.stack > 0 && (hasCallableOpponent(state, p) || need > 0)) {
    types.push("allin");
  }

  return types;
}

/**
 * Validate a concrete raise-to amount. Returns true when legal. A short all-in
 * (whole stack, below the normal minimum) is legal; it simply does not reopen
 * betting — that distinction is enforced in game.ts, not here.
 */
export function isLegalRaiseTo(state: GameState, p: PlayerState, to: number): boolean {
  if (p.hasActed) return false; // betting not reopened for this player
  if (!hasCallableOpponent(state, p)) return false; // no one left to call
  const bounds = raiseBounds(state, p);
  if (!bounds) return false;
  if (to > bounds.max) return false;
  if (to <= state.currentBet) return false;
  const isAllIn = to === bounds.max;
  return to >= bounds.min || isAllIn;
}

/**
 * Does this player still owe an action this street? True when they are active
 * and either have not acted since the last aggression or still owe chips to
 * match the current bet (e.g. after a short all-in raised the price).
 */
export function needsToAct(state: GameState, p: PlayerState): boolean {
  return isActive(p) && (!p.hasActed || p.streetCommitted < state.currentBet);
}

/**
 * The betting round is complete when every player still able to act has acted
 * since the last aggressive action and has matched the current bet.
 *
 * Special cases handled naturally by `hasActed`:
 *  - the big blind's preflop option (BB has not "acted" after posting);
 *  - a short all-in that does not reopen betting (players already acted keep
 *    `hasActed = true`).
 */
export function isBettingRoundComplete(state: GameState): boolean {
  const contenders = state.players.filter((p) => p.inHand && !p.folded);
  // Only one player left in the hand -> round (and hand) is over.
  if (contenders.length <= 1) return true;

  const actors = contenders.filter((p) => !p.allIn);
  // Everyone (else) is all-in: nothing left to decide this street.
  if (actors.length === 0) return true;
  // Only one player can still wager: betting is closed once they have matched
  // the current bet (they cannot raise into all-in opponents). Any uncalled
  // excess they already committed is returned as a side pot at showdown.
  if (actors.length === 1) return actors[0]!.streetCommitted >= state.currentBet;

  return actors.every((p) => p.hasActed && p.streetCommitted === state.currentBet);
}
