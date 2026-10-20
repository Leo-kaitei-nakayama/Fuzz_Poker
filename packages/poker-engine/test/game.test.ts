import { describe, it, expect } from "vitest";
import { cardsFromString, type Card } from "@cute-poker/shared";
import {
  applyAction,
  legalActions,
  startHand,
  totalChips,
  type SeatConfig,
} from "../src/game.js";

function seat(id: string, s: number, stack: number): SeatConfig {
  return { id, seat: s, stack };
}

function player(state: ReturnType<typeof startHand>, id: string) {
  return state.players.find((p) => p.id === id)!;
}

describe("blinds & positions", () => {
  it("6-max: SB left of button, BB next, UTG acts first preflop", () => {
    const state = startHand({
      players: [
        seat("btn", 0, 1000),
        seat("sb", 1, 1000),
        seat("bb", 2, 1000),
        seat("utg", 3, 1000),
        seat("mp", 4, 1000),
        seat("co", 5, 1000),
      ],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
    });
    expect(player(state, "sb").streetCommitted).toBe(10);
    expect(player(state, "bb").streetCommitted).toBe(20);
    expect(state.currentBet).toBe(20);
    expect(state.toActSeat).toBe(3); // UTG
  });

  it("heads-up: button is the small blind and acts first preflop", () => {
    const state = startHand({
      players: [seat("btn", 0, 1000), seat("opp", 1, 1000)],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
    });
    expect(player(state, "btn").streetCommitted).toBe(10); // button = SB
    expect(player(state, "opp").streetCommitted).toBe(20); // BB
    expect(state.toActSeat).toBe(0); // button acts first preflop
  });

  it("heads-up: big blind acts first postflop", () => {
    let state = startHand({
      players: [seat("btn", 0, 1000), seat("opp", 1, 1000)],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
    });
    state = applyAction(state, { type: "call" }); // btn (SB) completes
    state = applyAction(state, { type: "check" }); // bb checks option
    expect(state.phase).toBe("FLOP");
    expect(state.toActSeat).toBe(1); // BB acts first postflop
  });
});

describe("uncontested pot", () => {
  it("everyone folds to the big blind — BB wins without showdown", () => {
    let state = startHand({
      players: [
        seat("btn", 0, 1000),
        seat("sb", 1, 1000),
        seat("bb", 2, 1000),
      ],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
    });
    state = applyAction(state, { type: "fold" }); // btn
    state = applyAction(state, { type: "fold" }); // sb
    expect(state.phase).toBe("HAND_END");
    expect(state.board).toHaveLength(0); // no cards revealed
    expect(state.results[0]!.winners).toEqual(["bb"]);
    expect(player(state, "bb").stack).toBe(1000 + 10); // won the small blind
    expect(totalChips(state)).toBe(3000);
  });
});

describe("short all-in does not reopen betting (SPEC §9.2)", () => {
  it("a sub-full all-in gives no re-raise right to a player who already acted", () => {
    // seat0 button (acts first 3-handed), seat1 SB (short stack), seat2 BB.
    let state = startHand({
      players: [
        seat("a", 0, 1000),
        seat("b", 1, 150),
        seat("c", 2, 1000),
      ],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
    });

    // a raises to 100 (full raise; increment 80 >= bb 20).
    state = applyAction(state, { type: "raise", amount: 100 });
    expect(state.currentBet).toBe(100);
    expect(state.lastRaiseSize).toBe(80);
    expect(state.toActSeat).toBe(1); // b (SB)

    // b is all-in for 150 total (posted 10 + stack 140). Increment 50 < 80 => short.
    state = applyAction(state, { type: "allin" });
    expect(player(state, "b").allIn).toBe(true);
    expect(player(state, "b").streetCommitted).toBe(150);
    expect(state.currentBet).toBe(150);
    expect(state.lastRaiseSize).toBe(80); // unchanged by the short all-in
    expect(state.toActSeat).toBe(2); // c

    // c has not acted, so c may still raise.
    const cOptions = legalActions(state)!;
    expect(cOptions.types).toContain("raise");

    // c just calls 150.
    state = applyAction(state, { type: "call" });
    expect(state.toActSeat).toBe(0); // back to a, who owes 50 more

    // a already acted and faces only a short all-in: NO re-raise right.
    const aOptions = legalActions(state)!;
    expect(aOptions.types).toContain("call");
    expect(aOptions.types).toContain("fold");
    expect(aOptions.types).not.toContain("raise");
    expect(aOptions.raise).toBeNull();
    expect(() => applyAction(state, { type: "raise", amount: 300 })).toThrow();
  });
});

describe("all-in run-out", () => {
  it("heads-up both all-in preflop runs the board to the river and ends", () => {
    // Deterministic deck. Deal order (button=SB first in HU) is [opp(seat1), btn(seat0)]
    // over two rounds, then 5 board cards.
    const deck: Card[] = cardsFromString(
      // round1: opp, btn ; round2: opp, btn
      "Ah Ks Ad Kd " +
        // board: flop(3) turn(1) river(1)
        "2c 7d 9h Qs 3s " +
        // filler (unused)
        "4c 5c 6c 8c Tc",
    );
    let state = startHand({
      players: [seat("btn", 0, 500), seat("opp", 1, 500)],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
      deck,
    });
    // btn (SB) shoves, opp calls all-in.
    state = applyAction(state, { type: "allin" });
    state = applyAction(state, { type: "allin" });
    expect(state.phase).toBe("HAND_END");
    expect(state.board).toHaveLength(5);
    // opp holds AhKs, btn holds AdKd; board pairs nothing special -> both A-K,
    // but opp has Ks over btn's Kd? Same ranks -> split (suits don't matter).
    const total = player(state, "btn").stack + player(state, "opp").stack;
    expect(total).toBe(1000);
    expect(totalChips(state)).toBe(1000);
  });
});

describe("basic full hand to showdown", () => {
  it("plays a limped pot to the river and awards a single pot", () => {
    let state = startHand({
      players: [seat("a", 0, 1000), seat("b", 1, 1000)],
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      handNumber: 1,
    });
    // Preflop
    state = applyAction(state, { type: "call" }); // a
    state = applyAction(state, { type: "check" }); // b
    // Flop, Turn, River: check it down
    for (const _ of ["flop", "turn", "river"]) {
      state = applyAction(state, { type: "check" }); // b first postflop
      state = applyAction(state, { type: "check" }); // a
    }
    expect(state.phase).toBe("HAND_END");
    expect(state.board).toHaveLength(5);
    expect(totalChips(state)).toBe(2000);
    expect(state.results.length).toBeGreaterThanOrEqual(1);
  });
});
