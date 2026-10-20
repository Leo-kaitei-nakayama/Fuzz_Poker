import type { Card } from "./cards.js";

/** Street / lifecycle phases (SPEC §3.1). */
export type Phase =
  | "WAITING"
  | "PREFLOP"
  | "FLOP"
  | "TURN"
  | "RIVER"
  | "SHOWDOWN"
  | "HAND_END";

export type ActionType = "fold" | "check" | "call" | "raise" | "allin";

/**
 * A player action. For `raise`, `amount` is the TOTAL chips the player wants
 * committed this street (the "raise-to" amount), not the increment — this is
 * the least ambiguous convention and matches most online clients.
 * `allin` ignores `amount` (the engine uses the whole stack).
 */
export interface Action {
  readonly type: ActionType;
  readonly amount?: number;
}

export interface PlayerState {
  readonly id: string;
  readonly seat: number;
  readonly stack: number;
  /** Hole cards; empty until dealt. Never broadcast to other players. */
  readonly holeCards: readonly Card[];
  readonly folded: boolean;
  readonly allIn: boolean;
  /** Total chips committed across the whole hand (all streets). */
  readonly committed: number;
  /** Chips committed on the current street only. */
  readonly streetCommitted: number;
  /** Whether the player has acted since the last bet/raise this street. */
  readonly hasActed: boolean;
  /** Player requested to sit out / is disconnected (auto fold/check). */
  readonly sittingOut: boolean;
  /** Seated but not in the current hand (joined mid-hand, busted, etc). */
  readonly inHand: boolean;
}

export interface PotResult {
  /** Chips awarded. */
  readonly amount: number;
  /** Winner player ids for this pot (split when more than one). */
  readonly winners: readonly string[];
  /** Per-winner payout (handles odd-chip remainder). id -> chips. */
  readonly payouts: Readonly<Record<string, number>>;
  /** Players eligible for this (side) pot. */
  readonly eligible: readonly string[];
}

export interface GameState {
  readonly phase: Phase;
  readonly handNumber: number;
  readonly sb: number;
  readonly bb: number;
  readonly players: readonly PlayerState[];
  readonly buttonSeat: number;
  /** Remaining undealt cards. */
  readonly deck: readonly Card[];
  readonly board: readonly Card[];
  /** Highest streetCommitted this round (the amount to match). */
  readonly currentBet: number;
  /** Size of the last full bet/raise this street (for min-raise legality). */
  readonly lastRaiseSize: number;
  /** Seat whose turn it is, or null when no action is pending. */
  readonly toActSeat: number | null;
  /** Seat of the last aggressor this street (for showdown reveal order). */
  readonly lastAggressorSeat: number | null;
  /** Populated at HAND_END. */
  readonly results: readonly PotResult[];
}
