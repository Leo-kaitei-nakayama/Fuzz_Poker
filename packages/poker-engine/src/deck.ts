import { randomInt } from "node:crypto";
import { RANKS, SUITS, type Card } from "@cute-poker/shared";

/** A standard 52-card deck in a fixed order (no joker). */
export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Source of randomness. Defaults to Node's cryptographically secure
 * `crypto.randomInt`. Tests may inject a deterministic generator.
 *
 * Contract: `randInt(n)` returns an integer in [0, n).
 */
export type RandInt = (maxExclusive: number) => number;

export const cryptoRandInt: RandInt = (maxExclusive: number) => randomInt(maxExclusive);

/**
 * Fisher–Yates shuffle (SPEC §9.1). Returns a NEW array; the input is not
 * mutated. Uses a cryptographic RNG by default so shuffles are unpredictable
 * and unbiased.
 */
export function shuffle(deck: readonly Card[], randInt: RandInt = cryptoRandInt): Card[] {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** A freshly shuffled 52-card deck. */
export function shuffledDeck(randInt: RandInt = cryptoRandInt): Card[] {
  return shuffle(freshDeck(), randInt);
}

/**
 * A seeded, deterministic RandInt built from a mulberry32 PRNG.
 * NOT cryptographically secure — for tests and reproducible simulations only.
 */
export function seededRandInt(seed: number): RandInt {
  let state = seed >>> 0;
  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (maxExclusive: number) => Math.floor(next() * maxExclusive);
}
