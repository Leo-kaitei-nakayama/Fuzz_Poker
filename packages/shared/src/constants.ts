/** Economy & table constants (SPEC §3.3, §4). */

export const SIGNUP_BONUS = 5_000;

/** Daily login streak rewards (SPEC §4.2), index 0 = day 1. */
export const DAILY_LOGIN_REWARDS: readonly number[] = [
  500, 600, 800, 1_000, 1_200, 1_500, 2_000,
];

/** Coin reflection factor when a bot participated in the hand (SPEC §4.5). */
export const BOT_HAND_REFLECTION_FACTOR = 0.2;
export const HUMAN_HAND_REFLECTION_FACTOR = 1.0;

export const DEFAULT_TURN_TIMEOUT_MS = 20_000;

export interface TableKind {
  readonly slug: string;
  readonly sb: number;
  readonly bb: number;
  readonly minBuyIn: number;
  readonly maxBuyIn: number;
  readonly maxSeats: number;
  readonly botsAllowed: boolean;
}

/** Table definitions (SPEC §3.3). */
export const TABLE_KINDS: Readonly<Record<string, TableKind>> = {
  practice: {
    slug: "practice",
    sb: 10,
    bb: 20,
    minBuyIn: 400,
    maxBuyIn: 2_000,
    maxSeats: 6,
    botsAllowed: true,
  },
  hiyoko: {
    slug: "hiyoko",
    sb: 10,
    bb: 20,
    minBuyIn: 400,
    maxBuyIn: 2_000,
    maxSeats: 6,
    botsAllowed: true,
  },
  usagi: {
    slug: "usagi",
    sb: 50,
    bb: 100,
    minBuyIn: 2_000,
    maxBuyIn: 10_000,
    maxSeats: 6,
    botsAllowed: false,
  },
  dragon: {
    slug: "dragon",
    sb: 500,
    bb: 1_000,
    minBuyIn: 20_000,
    maxBuyIn: 100_000,
    maxSeats: 6,
    botsAllowed: false,
  },
};
