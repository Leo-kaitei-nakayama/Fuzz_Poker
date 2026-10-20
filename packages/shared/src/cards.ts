/**
 * Card primitives shared across the engine, server and client.
 *
 * Ranks are numeric (2..14) so comparisons are trivial; the Ace is 14 but the
 * evaluator also treats it as 1 for the wheel (A-2-3-4-5) — see poker-engine.
 */

export type Suit = "c" | "d" | "h" | "s";

/** 2..10, J=11, Q=12, K=13, A=14 */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

export const SUITS: readonly Suit[] = ["c", "d", "h", "s"] as const;
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

const RANK_TO_CHAR: Record<Rank, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

const CHAR_TO_RANK: Record<string, Rank> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/** Human/debug/test notation, e.g. "As", "Td", "2c". */
export function cardToString(card: Card): string {
  return `${RANK_TO_CHAR[card.rank]}${card.suit}`;
}

/** Parse "As", "Td", "2c" into a Card. Throws on malformed input. */
export function cardFromString(s: string): Card {
  if (s.length < 2 || s.length > 3) {
    throw new Error(`Invalid card string: ${s}`);
  }
  const suit = s[s.length - 1] as Suit;
  const rankPart = s.slice(0, s.length - 1);
  const rank = CHAR_TO_RANK[rankPart];
  if (rank === undefined || !SUITS.includes(suit)) {
    throw new Error(`Invalid card string: ${s}`);
  }
  return { rank, suit };
}

/** Convenience for tests: parse a space/comma separated list of cards. */
export function cardsFromString(s: string): Card[] {
  return s
    .trim()
    .split(/[\s,]+/)
    .filter((t) => t.length > 0)
    .map(cardFromString);
}
