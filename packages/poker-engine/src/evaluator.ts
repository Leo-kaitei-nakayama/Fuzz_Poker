import type { Card, Rank } from "@cute-poker/shared";

/**
 * Hand categories, higher is stronger (SPEC §3.2 役判定).
 */
export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

export const HAND_CATEGORY_NAME: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High Card",
  [HandCategory.OnePair]: "One Pair",
  [HandCategory.TwoPair]: "Two Pair",
  [HandCategory.ThreeOfAKind]: "Three of a Kind",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full House",
  [HandCategory.FourOfAKind]: "Four of a Kind",
  [HandCategory.StraightFlush]: "Straight Flush",
};

/**
 * An evaluated hand. `tiebreakers` is a list of ranks in descending order of
 * significance; two hands are compared first by `category`, then lexicographically
 * by `tiebreakers`. This makes kickers and split pots fall out naturally.
 */
export interface HandValue {
  readonly category: HandCategory;
  readonly tiebreakers: readonly number[];
  /** The best 5 cards forming this value (for UI / showdown display). */
  readonly cards: readonly Card[];
}

/** Compare two hand values. >0 if a beats b, <0 if b beats a, 0 if tie. */
export function compareHands(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** Royal flush is simply the highest straight flush (ace-high). Convenience. */
export function isRoyalFlush(v: HandValue): boolean {
  return v.category === HandCategory.StraightFlush && v.tiebreakers[0] === 14;
}

interface RankGroup {
  readonly rank: Rank;
  readonly count: number;
}

/**
 * Evaluate EXACTLY 5 cards.
 */
export function evaluate5(cards: readonly Card[]): HandValue {
  if (cards.length !== 5) {
    throw new Error(`evaluate5 expects 5 cards, got ${cards.length}`);
  }

  const ranksDesc = cards.map((c) => c.rank).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.suit === cards[0]!.suit);

  const straightHigh = straightHighCard(ranksDesc);
  const isStraight = straightHigh !== null;

  // Group by rank, ordered by (count desc, rank desc).
  const counts = new Map<Rank, number>();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  const groups: RankGroup[] = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => (b.count - a.count) || (b.rank - a.rank));

  if (isStraight && isFlush) {
    return { category: HandCategory.StraightFlush, tiebreakers: [straightHigh], cards };
  }

  if (groups[0]!.count === 4) {
    const quad = groups[0]!.rank;
    const kicker = groups[1]!.rank;
    return { category: HandCategory.FourOfAKind, tiebreakers: [quad, kicker], cards };
  }

  if (groups[0]!.count === 3 && groups[1]!.count === 2) {
    return {
      category: HandCategory.FullHouse,
      tiebreakers: [groups[0]!.rank, groups[1]!.rank],
      cards,
    };
  }

  if (isFlush) {
    return { category: HandCategory.Flush, tiebreakers: ranksDesc, cards };
  }

  if (isStraight) {
    return { category: HandCategory.Straight, tiebreakers: [straightHigh], cards };
  }

  if (groups[0]!.count === 3) {
    const trips = groups[0]!.rank;
    const kickers = groups.slice(1).map((g) => g.rank);
    return { category: HandCategory.ThreeOfAKind, tiebreakers: [trips, ...kickers], cards };
  }

  if (groups[0]!.count === 2 && groups[1]!.count === 2) {
    const highPair = Math.max(groups[0]!.rank, groups[1]!.rank);
    const lowPair = Math.min(groups[0]!.rank, groups[1]!.rank);
    const kicker = groups[2]!.rank;
    return { category: HandCategory.TwoPair, tiebreakers: [highPair, lowPair, kicker], cards };
  }

  if (groups[0]!.count === 2) {
    const pair = groups[0]!.rank;
    const kickers = groups.slice(1).map((g) => g.rank);
    return { category: HandCategory.OnePair, tiebreakers: [pair, ...kickers], cards };
  }

  return { category: HandCategory.HighCard, tiebreakers: ranksDesc, cards };
}

/**
 * Returns the high card of a straight contained in the 5 given ranks (sorted
 * descending), or null if they are not a straight. Handles the A-2-3-4-5
 * wheel, whose high card is 5 (SPEC §3.2).
 */
function straightHighCard(ranksDesc: readonly number[]): number | null {
  const unique = [...new Set(ranksDesc)];
  if (unique.length !== 5) return null;
  // Normal straight: consecutive.
  if (unique[0]! - unique[4]! === 4) return unique[0]!;
  // Wheel: A,5,4,3,2 -> high card 5.
  if (
    unique[0] === 14 &&
    unique[1] === 5 &&
    unique[2] === 4 &&
    unique[3] === 3 &&
    unique[4] === 2
  ) {
    return 5;
  }
  return null;
}

/**
 * Evaluate the best 5-card hand out of 5, 6 or 7 cards (SPEC §3.2) by trying
 * every 5-card combination. For 7 cards that is C(7,5) = 21 combinations, which
 * is more than fast enough and keeps the code obviously correct.
 */
export function evaluateBest(cards: readonly Card[]): HandValue {
  if (cards.length < 5) {
    throw new Error(`evaluateBest expects at least 5 cards, got ${cards.length}`);
  }
  if (cards.length === 5) return evaluate5(cards);

  let best: HandValue | null = null;
  for (const combo of combinations5(cards)) {
    const v = evaluate5(combo);
    if (best === null || compareHands(v, best) > 0) best = v;
  }
  return best!;
}

/** Yield all 5-card subsets of the input. */
function* combinations5(cards: readonly Card[]): Generator<Card[]> {
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++)
            yield [cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!];
}
