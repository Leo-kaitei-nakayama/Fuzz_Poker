import { describe, it, expect } from "vitest";
import type { Action } from "@cute-poker/shared";
import { seededRandInt } from "../src/deck.js";
import {
  applyAction,
  legalActions,
  startHand,
  totalChips,
  type SeatConfig,
} from "../src/game.js";

/** Pick one legal action for the player to act, using the given RNG. */
function pickAction(state: ReturnType<typeof startHand>, rnd: () => number): Action {
  const la = legalActions(state);
  if (!la) throw new Error("no action pending");

  // Bias away from folding so hands reach showdowns often, exercising pots.
  const weighted = la.types.filter((t) => t !== "fold");
  const pool = rnd() < 0.1 || weighted.length === 0 ? la.types : weighted;
  const type = pool[Math.floor(rnd() * pool.length)]!;

  if (type === "raise" && la.raise) {
    const { min, max } = la.raise;
    if (max < min) return { type: "allin" };
    const span = max - min;
    const amount = min + Math.floor(rnd() * (span + 1));
    return { type: "raise", amount };
  }
  return { type };
}

describe("property: chip conservation", () => {
  it("total chips are conserved through many random hands", () => {
    for (let trial = 0; trial < 400; trial++) {
      const rng = seededRandInt(trial * 2654435761);
      const rnd = () => rng(1_000_000) / 1_000_000;

      const n = 2 + Math.floor(rnd() * 5); // 2..6 players
      const players: SeatConfig[] = [];
      let startTotal = 0;
      for (let i = 0; i < n; i++) {
        const stack = 100 + Math.floor(rnd() * 1900); // 100..1999
        startTotal += stack;
        players.push({ id: `p${i}`, seat: i, stack });
      }

      let state = startHand({
        players,
        buttonSeat: 0,
        sb: 10,
        bb: 20,
        handNumber: 1,
        randInt: (nn) => rng(nn),
      });

      // Invariant holds immediately after the deal.
      expect(totalChips(state)).toBe(startTotal);

      let guard = 0;
      while (state.phase !== "HAND_END") {
        if (++guard > 10_000) throw new Error("hand did not terminate");
        state = applyAction(state, pickAction(state, rnd));
        expect(totalChips(state)).toBe(startTotal);
      }

      // At hand end, the pot is empty and every chip is back in a stack.
      const stackSum = state.players.reduce((s, p) => s + p.stack, 0);
      expect(stackSum).toBe(startTotal);
      for (const p of state.players) {
        expect(p.committed).toBe(0);
        expect(p.stack).toBeGreaterThanOrEqual(0);
      }

      // Pot payouts sum to the chips that were wagered.
      const paid = state.results
        .flatMap((r) => Object.values(r.payouts))
        .reduce((s, x) => s + x, 0);
      const potTotal = state.results.reduce((s, r) => s + r.amount, 0);
      expect(paid).toBe(potTotal);
    }
  });

  it("never produces a negative stack or lost chip in heads-up marathons", () => {
    const rng = seededRandInt(99);
    const rnd = () => rng(1_000_000) / 1_000_000;
    let stacks = { a: 1000, b: 1000 };
    let button = 0;

    for (let hand = 0; hand < 200; hand++) {
      if (stacks.a <= 0 || stacks.b <= 0) break;
      const before = stacks.a + stacks.b;
      let state = startHand({
        players: [
          { id: "a", seat: 0, stack: stacks.a },
          { id: "b", seat: 1, stack: stacks.b },
        ],
        buttonSeat: button,
        sb: 10,
        bb: 20,
        handNumber: hand + 1,
        randInt: (nn) => rng(nn),
      });

      let guard = 0;
      while (state.phase !== "HAND_END") {
        if (++guard > 10_000) throw new Error("hand did not terminate");
        state = applyAction(state, pickAction(state, rnd));
      }

      stacks = {
        a: state.players.find((p) => p.id === "a")!.stack,
        b: state.players.find((p) => p.id === "b")!.stack,
      };
      expect(stacks.a + stacks.b).toBe(before);
      expect(stacks.a).toBeGreaterThanOrEqual(0);
      expect(stacks.b).toBeGreaterThanOrEqual(0);
      button = button === 0 ? 1 : 0;
    }
  });
});
