import { describe, it, expect } from "vitest";
import { cardsFromString } from "@cute-poker/shared";
import {
  HandCategory,
  compareHands,
  evaluate5,
  evaluateBest,
  isRoyalFlush,
} from "../src/evaluator.js";

const ev = (s: string) => evaluate5(cardsFromString(s));
const best = (s: string) => evaluateBest(cardsFromString(s));

describe("evaluate5 — every category", () => {
  it("royal flush", () => {
    const v = ev("As Ks Qs Js Ts");
    expect(v.category).toBe(HandCategory.StraightFlush);
    expect(v.tiebreakers[0]).toBe(14);
    expect(isRoyalFlush(v)).toBe(true);
  });

  it("straight flush (non-royal)", () => {
    const v = ev("9h 8h 7h 6h 5h");
    expect(v.category).toBe(HandCategory.StraightFlush);
    expect(v.tiebreakers[0]).toBe(9);
    expect(isRoyalFlush(v)).toBe(false);
  });

  it("wheel straight flush (A-2-3-4-5) ranks as 5-high", () => {
    const v = ev("As 2s 3s 4s 5s");
    expect(v.category).toBe(HandCategory.StraightFlush);
    expect(v.tiebreakers[0]).toBe(5);
  });

  it("four of a kind with kicker", () => {
    const v = ev("9c 9d 9h 9s Kd");
    expect(v.category).toBe(HandCategory.FourOfAKind);
    expect(v.tiebreakers).toEqual([9, 13]);
  });

  it("full house", () => {
    const v = ev("8c 8d 8h Qs Qd");
    expect(v.category).toBe(HandCategory.FullHouse);
    expect(v.tiebreakers).toEqual([8, 12]);
  });

  it("flush uses all five ranks as tiebreakers", () => {
    const v = ev("Ad Jd 9d 6d 3d");
    expect(v.category).toBe(HandCategory.Flush);
    expect(v.tiebreakers).toEqual([14, 11, 9, 6, 3]);
  });

  it("plain straight", () => {
    const v = ev("9c 8d 7h 6s 5d");
    expect(v.category).toBe(HandCategory.Straight);
    expect(v.tiebreakers[0]).toBe(9);
  });

  it("wheel straight (A-2-3-4-5) is 5-high", () => {
    const v = ev("Ac 2d 3h 4s 5d");
    expect(v.category).toBe(HandCategory.Straight);
    expect(v.tiebreakers[0]).toBe(5);
  });

  it("broadway straight (T-J-Q-K-A) is ace-high", () => {
    const v = ev("Tc Jd Qh Ks Ad");
    expect(v.category).toBe(HandCategory.Straight);
    expect(v.tiebreakers[0]).toBe(14);
  });

  it("three of a kind with kickers", () => {
    const v = ev("7c 7d 7h Ks 2d");
    expect(v.category).toBe(HandCategory.ThreeOfAKind);
    expect(v.tiebreakers).toEqual([7, 13, 2]);
  });

  it("two pair, high pair then low pair then kicker", () => {
    const v = ev("Kc Kd 4h 4s 9d");
    expect(v.category).toBe(HandCategory.TwoPair);
    expect(v.tiebreakers).toEqual([13, 4, 9]);
  });

  it("one pair with three kickers", () => {
    const v = ev("Tc Td Ah 7s 3d");
    expect(v.category).toBe(HandCategory.OnePair);
    expect(v.tiebreakers).toEqual([10, 14, 7, 3]);
  });

  it("high card", () => {
    const v = ev("Ad Jc 9h 6s 3d");
    expect(v.category).toBe(HandCategory.HighCard);
    expect(v.tiebreakers).toEqual([14, 11, 9, 6, 3]);
  });

  it("A-high is not a straight when not consecutive (A-K-Q-J-9)", () => {
    const v = ev("Ad Kc Qh Js 9d");
    expect(v.category).toBe(HandCategory.HighCard);
  });
});

describe("compareHands — ordering and kickers", () => {
  it("category dominates", () => {
    expect(compareHands(ev("Ad Ac Ah As Kd"), ev("9h 8h 7h 6h 5h"))).toBeLessThan(0);
  });

  it("higher pair beats lower pair", () => {
    expect(compareHands(ev("Kc Kd 5h 4s 2d"), ev("Qc Qd Ah Ks Jd"))).toBeGreaterThan(0);
  });

  it("same pair decided by kicker", () => {
    const a = ev("Tc Td Ah 7s 3d");
    const b = ev("Ts Th Kc 7d 3h");
    expect(compareHands(a, b)).toBeGreaterThan(0); // A kicker beats K kicker
  });

  it("identical hands tie", () => {
    const a = ev("Tc Td Ah 7s 3d");
    const b = ev("Th Ts Ad 7c 3h");
    expect(compareHands(a, b)).toBe(0);
  });

  it("wheel loses to six-high straight", () => {
    expect(compareHands(ev("Ac 2d 3h 4s 5d"), ev("2c 3d 4h 5s 6d"))).toBeLessThan(0);
  });
});

describe("evaluateBest — 7 cards", () => {
  it("picks the best five of seven", () => {
    // Flush of hearts available among 7.
    const v = best("Ah Kh 2c 7h 9h 3d 4h");
    expect(v.category).toBe(HandCategory.Flush);
    expect(v.tiebreakers).toEqual([14, 13, 9, 7, 4]);
  });

  it("finds quads over a tempting full house", () => {
    const v = best("9c 9d 9h 9s Kd Kc 2h");
    expect(v.category).toBe(HandCategory.FourOfAKind);
    expect(v.tiebreakers).toEqual([9, 13]);
  });

  it("board plays — both players tie when the board is the best hand", () => {
    const board = "As Ks Qs Js Ts"; // royal flush on the board
    const p1 = evaluateBest(cardsFromString(`2c 3d ${board}`));
    const p2 = evaluateBest(cardsFromString(`7h 8h ${board}`));
    expect(compareHands(p1, p2)).toBe(0);
    expect(isRoyalFlush(p1)).toBe(true);
  });
});
