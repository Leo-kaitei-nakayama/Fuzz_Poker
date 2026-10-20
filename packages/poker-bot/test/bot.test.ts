import { describe, it, expect } from "vitest";
import { cardsFromString } from "@cute-poker/shared";
import {
  applyAction,
  legalActions,
  seededRandInt,
  startHand,
  totalChips,
  type SeatConfig,
} from "@cute-poker/poker-engine";
import { decideAction, preflopTier, type Difficulty } from "../src/index.js";

function mkRng(seed: number): () => number {
  const r = seededRandInt(seed);
  return () => r(1_000_000) / 1_000_000;
}

describe("preflopTier", () => {
  it("rates premium holdings", () => {
    expect(preflopTier(cardsFromString("As Ad"))).toBe("premium");
    expect(preflopTier(cardsFromString("Ks Kd"))).toBe("premium");
    expect(preflopTier(cardsFromString("As Ks"))).toBe("premium"); // AKs
  });
  it("rates trash as trash", () => {
    expect(preflopTier(cardsFromString("7c 2d"))).toBe("trash");
    expect(preflopTier(cardsFromString("9c 3h"))).toBe("trash");
  });
  it("suited aces / connectors are at least playable", () => {
    expect(preflopTier(cardsFromString("As 4s"))).not.toBe("trash");
    expect(preflopTier(cardsFromString("7s 6s"))).not.toBe("trash");
  });
});

describe("decideAction — always legal", () => {
  for (const difficulty of ["easy", "normal"] as Difficulty[]) {
    it(`${difficulty}: every decision is a legal action across many hands`, () => {
      for (let trial = 0; trial < 150; trial++) {
        const rng = mkRng(trial + 1);
        const n = 2 + Math.floor(rng() * 5);
        const players: SeatConfig[] = [];
        for (let i = 0; i < n; i++) {
          players.push({ id: `b${i}`, seat: i, stack: 200 + Math.floor(rng() * 1800) });
        }
        let state = startHand({
          players,
          buttonSeat: 0,
          sb: 10,
          bb: 20,
          handNumber: 1,
          randInt: seededRandInt(trial * 7919 + 1),
        });
        const startTotal = totalChips(state);

        let guard = 0;
        while (state.phase !== "HAND_END") {
          if (++guard > 5000) throw new Error("hand did not terminate");
          const la = legalActions(state)!;
          const action = decideAction({ state, seat: la.seat, difficulty, rng });
          // The engine throws on an illegal action — that is our assertion.
          state = applyAction(state, action);
        }
        // Bots must never create or destroy chips.
        expect(totalChips(state)).toBe(startTotal);
      }
    });
  }
});

describe("Normal bot discipline", () => {
  it("folds trash in early position facing a raise", () => {
    // 6-max; UTG (seat 3) acts first and holds 7-2 offsuit facing the BB.
    // Build a deck so UTG is dealt 7c 2d. Deal order starts at SB (seat 1),
    // two cards each: sb, bb, utg, mp, co, btn.
    // Round1: sb,bb,utg,mp,co,btn  Round2: sb,bb,utg,mp,co,btn
    const deck = cardsFromString(
      // r1: sb bb utg mp co btn
      "Ac Ad 7c Qh Qd Jh " +
        // r2: sb bb utg mp co btn
        "Ah Ks 2d Qs Jd Jc " +
        // board + filler
        "2h 3h 4h 5h 6h 8c 9c Tc",
    );
    let state = startHand({
      players: [
        { id: "btn", seat: 0, stack: 1000 },
        { id: "sb", seat: 1, stack: 1000 },
        { id: "bb", seat: 2, stack: 1000 },
        { id: "utg", seat: 3, stack: 1000 },
        { id: "mp", seat: 4, stack: 1000 },
        { id: "co", seat: 5, stack: 1000 },
      ],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
      deck,
    });
    expect(state.toActSeat).toBe(3); // UTG
    const utg = state.players.find((p) => p.seat === 3)!;
    expect(utg.holeCards.map((c) => c.rank).sort()).toEqual([2, 7]);

    const action = decideAction({ state, seat: 3, difficulty: "normal", rng: mkRng(1) });
    expect(action.type).toBe("fold");
  });

  it("raises premium hands when unopened", () => {
    // Heads-up: button (seat0) is SB and acts first, dealt AA.
    // HU deal order is [opp(seat1), btn(seat0)] per round, so the button gets
    // deck[1] and deck[3].
    const deck = cardsFromString("Kc Ac Kd Ad 4h 9h Th Js Qs 3c 5c 6c");
    const state = startHand({
      players: [
        { id: "btn", seat: 0, stack: 1000 },
        { id: "opp", seat: 1, stack: 1000 },
      ],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
      deck,
    });
    const btn = state.players.find((p) => p.seat === 0)!;
    expect(btn.holeCards.map((c) => c.rank).sort()).toEqual([14, 14]);
    const action = decideAction({ state, seat: 0, difficulty: "normal", rng: mkRng(5) });
    expect(action.type).toBe("raise");
    expect(action.amount!).toBeGreaterThan(state.currentBet);
  });
});
