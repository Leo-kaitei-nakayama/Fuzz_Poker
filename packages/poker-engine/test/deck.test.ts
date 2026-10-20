import { describe, it, expect } from "vitest";
import { cardToString } from "@cute-poker/shared";
import { freshDeck, seededRandInt, shuffle, shuffledDeck } from "../src/deck.js";

describe("deck", () => {
  it("fresh deck has 52 unique cards", () => {
    const deck = freshDeck();
    expect(deck).toHaveLength(52);
    const strings = new Set(deck.map(cardToString));
    expect(strings.size).toBe(52);
  });

  it("shuffle is a permutation (same multiset of cards)", () => {
    const deck = freshDeck();
    const shuffled = shuffle(deck, seededRandInt(12345));
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled.map(cardToString)).size).toBe(52);
    // Original is not mutated.
    expect(deck.map(cardToString)).toEqual(freshDeck().map(cardToString));
  });

  it("seeded shuffle is deterministic", () => {
    const a = shuffle(freshDeck(), seededRandInt(42)).map(cardToString);
    const b = shuffle(freshDeck(), seededRandInt(42)).map(cardToString);
    expect(a).toEqual(b);
  });

  it("different seeds generally differ", () => {
    const a = shuffle(freshDeck(), seededRandInt(1)).map(cardToString);
    const b = shuffle(freshDeck(), seededRandInt(2)).map(cardToString);
    expect(a).not.toEqual(b);
  });

  it("crypto-backed shuffledDeck also yields 52 unique cards", () => {
    expect(new Set(shuffledDeck().map(cardToString)).size).toBe(52);
  });
});
