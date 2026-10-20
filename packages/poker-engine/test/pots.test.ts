import { describe, it, expect } from "vitest";
import { cardsFromString } from "@cute-poker/shared";
import { evaluateBest, type HandValue } from "../src/evaluator.js";
import { awardPots, buildSidePots, type Contribution } from "../src/pots.js";

function sumPots(pots: { amount: number }[]): number {
  return pots.reduce((s, p) => s + p.amount, 0);
}

describe("buildSidePots", () => {
  it("single pot when everyone contributes equally", () => {
    const pots = buildSidePots([
      { id: "a", committed: 100, folded: false },
      { id: "b", committed: 100, folded: false },
      { id: "c", committed: 100, folded: false },
    ]);
    expect(pots).toHaveLength(1);
    expect(pots[0]!.amount).toBe(300);
    expect(new Set(pots[0]!.eligible)).toEqual(new Set(["a", "b", "c"]));
  });

  it("three-way staged all-ins build a main pot and two side pots", () => {
    // a all-in 50, b all-in 100, c all-in 200 (c has excess uncalled).
    const contribs: Contribution[] = [
      { id: "a", committed: 50, folded: false },
      { id: "b", committed: 100, folded: false },
      { id: "c", committed: 200, folded: false },
    ];
    const pots = buildSidePots(contribs);
    expect(sumPots(pots)).toBe(350);
    // Main pot: 50*3 = 150, eligible a,b,c
    expect(pots[0]!.amount).toBe(150);
    expect(new Set(pots[0]!.eligible)).toEqual(new Set(["a", "b", "c"]));
    // Side pot 1: 50*2 = 100, eligible b,c
    expect(pots[1]!.amount).toBe(100);
    expect(new Set(pots[1]!.eligible)).toEqual(new Set(["b", "c"]));
    // Side pot 2: 100, eligible c only (uncalled -> returns to c on award)
    expect(pots[2]!.amount).toBe(100);
    expect(pots[2]!.eligible).toEqual(["c"]);
  });

  it("folded players' chips stay in the pot but they are not eligible", () => {
    const pots = buildSidePots([
      { id: "a", committed: 100, folded: false },
      { id: "b", committed: 100, folded: true },
      { id: "c", committed: 40, folded: false },
    ]);
    expect(sumPots(pots)).toBe(240);
    // Level 40: a,b,c contribute -> 120, eligible a,c (b folded)
    expect(pots[0]!.amount).toBe(120);
    expect(new Set(pots[0]!.eligible)).toEqual(new Set(["a", "c"]));
    // Level 60 more: a,b -> 120, eligible a (b folded)
    expect(pots[1]!.amount).toBe(120);
    expect(pots[1]!.eligible).toEqual(["a"]);
  });

  it("conserves chips for many random contribution sets", () => {
    for (let trial = 0; trial < 200; trial++) {
      const contribs: Contribution[] = [];
      let total = 0;
      const n = 2 + (trial % 5);
      for (let i = 0; i < n; i++) {
        const c = (trial * 7 + i * 13) % 200;
        total += c;
        contribs.push({ id: `p${i}`, committed: c, folded: (trial + i) % 3 === 0 });
      }
      expect(sumPots(buildSidePots(contribs))).toBe(total);
    }
  });
});

describe("awardPots", () => {
  const hv = (s: string): HandValue => evaluateBest(cardsFromString(s));

  it("awards the whole pot to the best hand", () => {
    const pots = buildSidePots([
      { id: "a", committed: 100, folded: false },
      { id: "b", committed: 100, folded: false },
    ]);
    const values = {
      a: hv("Ah Ad Kc Qd Js 9h 2c"), // pair of aces
      b: hv("Kh Kd Qc Jd 9s 7h 2c"), // pair of kings
    };
    const awards = awardPots(pots, values, ["a", "b"]);
    expect(awards[0]!.winners).toEqual(["a"]);
    expect(awards[0]!.payouts["a"]).toBe(200);
    expect(awards[0]!.payouts["b"]).toBe(0);
  });

  it("splits an even pot between tied hands", () => {
    const pots = buildSidePots([
      { id: "a", committed: 100, folded: false },
      { id: "b", committed: 100, folded: false },
    ]);
    const board = "As Ks Qs Js Ts";
    const values = { a: hv(`2c 3d ${board}`), b: hv(`7h 8h ${board}`) };
    const awards = awardPots(pots, values, ["a", "b"]);
    expect(new Set(awards[0]!.winners)).toEqual(new Set(["a", "b"]));
    expect(awards[0]!.payouts["a"]).toBe(100);
    expect(awards[0]!.payouts["b"]).toBe(100);
  });

  it("odd chip on a split goes to the earliest position", () => {
    // Three equal contributors, one folded, leaves an odd 201-chip pot that is
    // split between the two tied live hands (100/101).
    const pots = buildSidePots([
      { id: "a", committed: 67, folded: false },
      { id: "b", committed: 67, folded: false },
      { id: "c", committed: 67, folded: true },
    ]);
    expect(pots).toHaveLength(1);
    expect(pots[0]!.amount).toBe(201);

    const board = "As Ks Qs Js Ts";
    const values = { a: hv(`2c 3d ${board}`), b: hv(`7h 8h ${board}`) };
    // positionOrder lists b first -> b gets the odd chip.
    const awards = awardPots(pots, values, ["b", "a"]);
    expect(awards[0]!.amount).toBe(201);
    expect(awards[0]!.payouts["b"]).toBe(101);
    expect(awards[0]!.payouts["a"]).toBe(100);
  });

  it("returns the uncalled side pot to its sole contributor", () => {
    const pots = buildSidePots([
      { id: "a", committed: 50, folded: false },
      { id: "b", committed: 200, folded: false },
    ]);
    // b has a weaker hand but still gets the uncalled 150 side pot back.
    const values = {
      a: hv("Ah Ad Kc Qd Js 9h 2c"), // aces
      b: hv("Kh Kd Qc Jd 9s 7h 2c"), // kings
    };
    const awards = awardPots(pots, values, ["a", "b"]);
    const total = awards.reduce((s, x) => s + x.amount, 0);
    expect(total).toBe(250);
    // Main pot 100 -> a (aces). Side pot 150 -> b (only eligible).
    const aTotal = awards.reduce((s, x) => s + (x.payouts["a"] ?? 0), 0);
    const bTotal = awards.reduce((s, x) => s + (x.payouts["b"] ?? 0), 0);
    expect(aTotal).toBe(100);
    expect(bTotal).toBe(150);
  });
});
