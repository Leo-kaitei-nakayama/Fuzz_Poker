import type { Card, GameState } from "@cute-poker/shared";
import { evaluateBest, HandCategory } from "@cute-poker/poker-engine";

/** A coarse preflop bucket for the two hole cards. */
export type PreflopTier = "premium" | "strong" | "medium" | "playable" | "trash";

/**
 * Classify a starting hand into a tier. Deliberately simple (not a solver):
 * enough for a believable Normal bot that beats beginners (SPEC §9.4.7).
 */
export function preflopTier(hole: readonly Card[]): PreflopTier {
  if (hole.length !== 2) return "trash";
  const [a, b] = hole as [Card, Card];
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const pair = a.rank === b.rank;
  const suited = a.suit === b.suit;
  const gap = hi - lo;

  if (pair) {
    if (hi >= 13) return "premium"; // AA, KK
    if (hi >= 11) return "strong"; // QQ, JJ
    if (hi >= 8) return "medium"; // TT-88
    return "playable"; // small pairs
  }

  // AK
  if (hi === 14 && lo === 13) return suited ? "premium" : "strong";
  // AQ, AJ, KQ
  if (hi >= 13 && lo >= 11) return suited ? "strong" : "medium";
  // Broadway-ish (both >= T)
  if (hi >= 10 && lo >= 10) return suited ? "strong" : "medium";
  // Ax suited, suited connectors, big suited
  if (suited && (hi === 14 || (gap <= 1 && lo >= 6))) return "medium";
  // suited connectors / one-gappers, offsuit broadway
  if ((suited && gap <= 2 && lo >= 4) || (hi >= 12 && lo >= 10)) return "playable";
  // small suited aces, connected cards
  if (suited && gap <= 1) return "playable";

  return "trash";
}

export interface MadeHand {
  readonly category: HandCategory;
  /** True when hero has top pair or better (relative to the board). */
  readonly strong: boolean;
  /** True when hero holds a pair using at least one hole card. */
  readonly hasPair: boolean;
}

/** Evaluate hero's current made hand against the board. */
export function madeHand(hole: readonly Card[], board: readonly Card[]): MadeHand {
  const v = evaluateBest([...hole, ...board]);
  const boardRanks = board.map((c) => c.rank);
  const topBoard = boardRanks.length ? Math.max(...boardRanks) : 0;

  // "Strong" = at least top pair (pair at or above the highest board card) or
  // any hand two-pair and up.
  let strong = v.category >= HandCategory.TwoPair;
  if (v.category === HandCategory.OnePair) {
    const pairRank = v.tiebreakers[0] ?? 0;
    if (pairRank >= topBoard) strong = true; // top pair or an overpair
  }
  const hasPair = v.category >= HandCategory.OnePair;
  return { category: v.category, strong, hasPair };
}

/** Detect a flush draw or open-ended straight draw using hole + board. */
export function hasDraw(hole: readonly Card[], board: readonly Card[]): boolean {
  if (board.length < 3 || board.length > 4) return false; // only flop/turn
  const cards = [...hole, ...board];

  // Flush draw: exactly four cards of one suit.
  const bySuit = new Map<string, number>();
  for (const c of cards) bySuit.set(c.suit, (bySuit.get(c.suit) ?? 0) + 1);
  if ([...bySuit.values()].some((n) => n === 4)) return true;

  // Open-ended straight draw: four consecutive distinct ranks (ace low & high).
  const ranks = new Set<number>(cards.map((c) => c.rank));
  if (ranks.has(14)) ranks.add(1);
  const sorted = [...ranks].sort((x, y) => x - y);
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! === sorted[i - 1]! + 1) {
      run++;
      if (run >= 4) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

/** Current pot size: everything committed by every player this hand. */
export function potSize(state: GameState): number {
  return state.players.reduce((sum, p) => sum + p.committed, 0);
}
