import type { HandValue } from "./evaluator.js";
import { compareHands } from "./evaluator.js";

export interface Contribution {
  readonly id: string;
  /** Total chips this player put into the pot across the whole hand. */
  readonly committed: number;
  /** Folded players forfeit eligibility but their chips still form pots. */
  readonly folded: boolean;
}

export interface SidePot {
  readonly amount: number;
  /** Player ids eligible to win this pot (contributed and not folded). */
  readonly eligible: readonly string[];
}

export interface PotAward {
  readonly amount: number;
  readonly winners: readonly string[];
  readonly payouts: Readonly<Record<string, number>>;
  readonly eligible: readonly string[];
}

/**
 * Split total contributions into a main pot and any side pots (SPEC §3.2).
 *
 * Algorithm: repeatedly peel off the smallest positive contribution level. At
 * each level every player who still has chips in contributes that slice; the
 * pot formed at that level is contestable by all non-folded players who
 * contributed to it. This correctly handles any number of staged all-ins.
 *
 * Total chips in the returned pots always equals the sum of `committed`.
 */
export function buildSidePots(contributions: readonly Contribution[]): SidePot[] {
  const remaining = contributions
    .filter((c) => c.committed > 0)
    .map((c) => ({ id: c.id, left: c.committed, folded: c.folded }));

  const pots: SidePot[] = [];

  while (remaining.some((c) => c.left > 0)) {
    const level = Math.min(...remaining.filter((c) => c.left > 0).map((c) => c.left));
    let amount = 0;
    const eligible: string[] = [];
    for (const c of remaining) {
      if (c.left > 0) {
        amount += level;
        c.left -= level;
        if (!c.folded) eligible.push(c.id);
      }
    }
    // Merge into the previous pot if the eligible set is identical (keeps the
    // pot list minimal, e.g. when several players cover the same level).
    const prev = pots[pots.length - 1];
    if (prev && sameSet(prev.eligible, eligible)) {
      pots[pots.length - 1] = { amount: prev.amount + amount, eligible: prev.eligible };
    } else {
      pots.push({ amount, eligible });
    }
  }

  return pots;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

/**
 * Award a set of side pots to winners.
 *
 * @param pots            side pots (from buildSidePots)
 * @param values          evaluated hand value per eligible player id
 * @param positionOrder   player ids ordered by seat position starting from the
 *                        first seat left of the button (SB-ward). Used to assign
 *                        odd-chip remainders to the earliest position on a split
 *                        (SPEC §3.2 端数処理: 余りチップは最初のポジションへ).
 */
export function awardPots(
  pots: readonly SidePot[],
  values: Readonly<Record<string, HandValue>>,
  positionOrder: readonly string[],
): PotAward[] {
  const orderIndex = new Map<string, number>();
  positionOrder.forEach((id, i) => orderIndex.set(id, i));

  return pots.map((pot) => {
    const winners = bestAmong(pot.eligible, values);
    const payouts: Record<string, number> = {};
    for (const id of pot.eligible) payouts[id] = 0;

    const base = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - base * winners.length;

    for (const id of winners) payouts[id] = base;

    // Hand out remainder chips one at a time, earliest position first.
    const remainderOrder = [...winners].sort(
      (a, b) => (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    for (let i = 0; remainder > 0; i = (i + 1) % remainderOrder.length) {
      payouts[remainderOrder[i]!] = (payouts[remainderOrder[i]!] ?? 0) + 1;
      remainder--;
    }

    return { amount: pot.amount, winners, payouts, eligible: pot.eligible };
  });
}

/** Return the id(s) with the strongest hand among the eligible set. */
function bestAmong(
  eligible: readonly string[],
  values: Readonly<Record<string, HandValue>>,
): string[] {
  let winners: string[] = [];
  let best: HandValue | null = null;
  for (const id of eligible) {
    const v = values[id];
    if (!v) continue;
    if (best === null) {
      best = v;
      winners = [id];
      continue;
    }
    const cmp = compareHands(v, best);
    if (cmp > 0) {
      best = v;
      winners = [id];
    } else if (cmp === 0) {
      winners.push(id);
    }
  }
  return winners;
}
