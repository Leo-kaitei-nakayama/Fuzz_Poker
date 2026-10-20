import { describe, it, expect } from "vitest";
import type { GameState, PlayerState } from "@cute-poker/shared";
import {
  hasCallableOpponent,
  isActive,
  isBettingRoundComplete,
  isLegalRaiseTo,
  legalActionTypes,
  needsToAct,
  raiseBounds,
  toCall,
} from "../src/betting.js";

function mkPlayer(p: Partial<PlayerState> & { id: string; seat: number }): PlayerState {
  return {
    stack: 1000,
    holeCards: [],
    folded: false,
    allIn: false,
    committed: 0,
    streetCommitted: 0,
    hasActed: false,
    sittingOut: false,
    inHand: true,
    ...p,
  };
}

function mkState(players: PlayerState[], over: Partial<GameState> = {}): GameState {
  return {
    phase: "FLOP",
    handNumber: 1,
    sb: 10,
    bb: 20,
    players,
    buttonSeat: 0,
    deck: [],
    board: [],
    currentBet: 0,
    lastRaiseSize: 20,
    toActSeat: players[0]?.seat ?? null,
    lastAggressorSeat: null,
    results: [],
    ...over,
  };
}

describe("isActive", () => {
  it("excludes folded, all-in and out-of-hand players", () => {
    expect(isActive(mkPlayer({ id: "a", seat: 0 }))).toBe(true);
    expect(isActive(mkPlayer({ id: "a", seat: 0, folded: true }))).toBe(false);
    expect(isActive(mkPlayer({ id: "a", seat: 0, allIn: true }))).toBe(false);
    expect(isActive(mkPlayer({ id: "a", seat: 0, inHand: false }))).toBe(false);
  });
});

describe("toCall & raiseBounds", () => {
  it("toCall is the shortfall versus the current bet", () => {
    const p = mkPlayer({ id: "a", seat: 0, streetCommitted: 50 });
    const state = mkState([p], { currentBet: 120 });
    expect(toCall(state, p)).toBe(70);
  });

  it("raiseBounds: min is current bet + last raise, max is all-in", () => {
    const p = mkPlayer({ id: "a", seat: 0, streetCommitted: 20, stack: 480 });
    const state = mkState([p, mkPlayer({ id: "b", seat: 1 })], {
      currentBet: 100,
      lastRaiseSize: 80,
    });
    expect(raiseBounds(state, p)).toEqual({ min: 180, max: 500 });
  });

  it("raiseBounds: min bet (no existing bet) is the big blind", () => {
    const p = mkPlayer({ id: "a", seat: 0, stack: 500 });
    const state = mkState([p, mkPlayer({ id: "b", seat: 1 })], {
      currentBet: 0,
      lastRaiseSize: 20,
    });
    expect(raiseBounds(state, p)).toEqual({ min: 20, max: 500 });
  });

  it("raiseBounds is null when the player cannot exceed the current bet", () => {
    const p = mkPlayer({ id: "a", seat: 0, streetCommitted: 0, stack: 50 });
    const state = mkState([p, mkPlayer({ id: "b", seat: 1 })], { currentBet: 100 });
    expect(raiseBounds(state, p)).toBeNull();
  });
});

describe("hasCallableOpponent", () => {
  it("false when every opponent is folded or all-in", () => {
    const hero = mkPlayer({ id: "h", seat: 0 });
    const state = mkState([
      hero,
      mkPlayer({ id: "x", seat: 1, folded: true }),
      mkPlayer({ id: "y", seat: 2, allIn: true }),
    ]);
    expect(hasCallableOpponent(state, hero)).toBe(false);
  });

  it("true when at least one opponent can still act", () => {
    const hero = mkPlayer({ id: "h", seat: 0 });
    const state = mkState([hero, mkPlayer({ id: "x", seat: 1 })]);
    expect(hasCallableOpponent(state, hero)).toBe(true);
  });
});

describe("legalActionTypes", () => {
  it("check + raise when nothing to call", () => {
    const hero = mkPlayer({ id: "h", seat: 0 });
    const state = mkState([hero, mkPlayer({ id: "x", seat: 1 })], { currentBet: 0 });
    const types = legalActionTypes(state, hero);
    expect(types).toContain("check");
    expect(types).toContain("raise");
    expect(types).not.toContain("call");
  });

  it("call instead of check when facing a bet", () => {
    const hero = mkPlayer({ id: "h", seat: 0, streetCommitted: 0 });
    const state = mkState([hero, mkPlayer({ id: "x", seat: 1 })], { currentBet: 40 });
    const types = legalActionTypes(state, hero);
    expect(types).toContain("call");
    expect(types).not.toContain("check");
  });

  it("no raise once the player has already acted (short all-in in front)", () => {
    const hero = mkPlayer({ id: "h", seat: 0, hasActed: true, streetCommitted: 100 });
    const state = mkState([hero, mkPlayer({ id: "x", seat: 1 })], {
      currentBet: 150,
      lastRaiseSize: 80,
    });
    expect(legalActionTypes(state, hero)).not.toContain("raise");
  });

  it("no raise/all-in luxury when no opponent can call and nothing is owed", () => {
    const hero = mkPlayer({ id: "h", seat: 0 });
    const state = mkState([hero, mkPlayer({ id: "x", seat: 1, allIn: true })], {
      currentBet: 0,
    });
    const types = legalActionTypes(state, hero);
    expect(types).not.toContain("raise");
    expect(types).not.toContain("allin");
    expect(types).toContain("check");
  });
});

describe("isLegalRaiseTo", () => {
  const hero = mkPlayer({ id: "h", seat: 0, streetCommitted: 20, stack: 480 });
  const state = mkState([hero, mkPlayer({ id: "x", seat: 1 })], {
    currentBet: 100,
    lastRaiseSize: 80,
  });

  it("accepts a full raise at or above the minimum", () => {
    expect(isLegalRaiseTo(state, hero, 180)).toBe(true);
    expect(isLegalRaiseTo(state, hero, 300)).toBe(true);
  });

  it("rejects a raise below the minimum that is not all-in", () => {
    expect(isLegalRaiseTo(state, hero, 150)).toBe(false);
  });

  it("accepts a short all-in (whole stack) even below the minimum", () => {
    const shorty = mkPlayer({ id: "s", seat: 0, streetCommitted: 20, stack: 130 });
    const st = mkState([shorty, mkPlayer({ id: "x", seat: 1 })], {
      currentBet: 100,
      lastRaiseSize: 80,
    });
    expect(isLegalRaiseTo(st, shorty, 150)).toBe(true); // 150 == all-in max
  });

  it("rejects once the player has already acted", () => {
    const acted = { ...hero, hasActed: true };
    expect(isLegalRaiseTo(state, acted, 300)).toBe(false);
  });
});

describe("needsToAct & isBettingRoundComplete", () => {
  it("round incomplete while someone still owes or has not acted", () => {
    const a = mkPlayer({ id: "a", seat: 0, hasActed: true, streetCommitted: 100 });
    const b = mkPlayer({ id: "b", seat: 1, hasActed: false, streetCommitted: 0 });
    const state = mkState([a, b], { currentBet: 100 });
    expect(needsToAct(state, b)).toBe(true);
    expect(isBettingRoundComplete(state)).toBe(false);
  });

  it("round complete when all active players have matched and acted", () => {
    const a = mkPlayer({ id: "a", seat: 0, hasActed: true, streetCommitted: 100 });
    const b = mkPlayer({ id: "b", seat: 1, hasActed: true, streetCommitted: 100 });
    const state = mkState([a, b], { currentBet: 100 });
    expect(isBettingRoundComplete(state)).toBe(true);
  });

  it("round complete when all but one are all-in and the last has matched", () => {
    const a = mkPlayer({ id: "a", seat: 0, allIn: true, streetCommitted: 100 });
    const b = mkPlayer({ id: "b", seat: 1, hasActed: true, streetCommitted: 100 });
    const state = mkState([a, b], { currentBet: 100 });
    expect(isBettingRoundComplete(state)).toBe(true);
  });

  it("round incomplete when the lone non-all-in player still owes a call", () => {
    const a = mkPlayer({ id: "a", seat: 0, allIn: true, streetCommitted: 300 });
    const b = mkPlayer({ id: "b", seat: 1, hasActed: false, streetCommitted: 100 });
    const state = mkState([a, b], { currentBet: 300 });
    expect(isBettingRoundComplete(state)).toBe(false);
  });

  it("round complete when only one contender remains (others folded)", () => {
    const a = mkPlayer({ id: "a", seat: 0 });
    const b = mkPlayer({ id: "b", seat: 1, folded: true });
    expect(isBettingRoundComplete(mkState([a, b]))).toBe(true);
  });
});
