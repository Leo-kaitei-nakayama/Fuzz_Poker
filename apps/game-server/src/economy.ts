import {
  BOT_HAND_REFLECTION_FACTOR,
  HUMAN_HAND_REFLECTION_FACTOR,
  SIGNUP_BONUS,
} from "@cute-poker/shared";
import type { Store } from "./store/types.js";

/**
 * SPEC §4.5 — coin reflection.
 *
 * Buy-in and cash-out move chips between wallet and table 1:1. The x0.2
 * compression for bot hands is applied to the *table stack* between hands:
 * after a hand in which a bot was dealt, each human's raw chip result is
 * multiplied by the factor, and the difference is recorded to `coin_sink`.
 * Because cash-out returns the (already-compressed) stack 1:1, the net wallet
 * effect over a session equals the sum of the per-hand compressed results,
 * exactly as the spec intends, while keeping the ledger simple and the wallet
 * balance always equal to the sum of its transactions (SPEC §4.4).
 */

export function factorForHand(botInHand: boolean): number {
  return botInHand ? BOT_HAND_REFLECTION_FACTOR : HUMAN_HAND_REFLECTION_FACTOR;
}

export interface Reflection {
  rawDelta: number;
  factor: number;
  reflectedDelta: number;
  /** rawDelta - reflectedDelta. Positive = chips destroyed; negative = injected. */
  destroyed: number;
}

export function reflect(rawDelta: number, factor: number): Reflection {
  const reflectedDelta = Math.round(rawDelta * factor);
  return { rawDelta, factor, reflectedDelta, destroyed: rawDelta - reflectedDelta };
}

/** Grant the one-time signup bonus (idempotent per user). */
export function grantSignupBonus(store: Store, userId: string): number {
  return store.applyLedger({
    userId,
    amount: SIGNUP_BONUS,
    reason: "signup_bonus",
    idempotencyKey: `signup:${userId}`,
  });
}

/** Deduct a table buy-in from the wallet. Throws if the balance is too low. */
export function buyIn(store: Store, userId: string, amount: number, tableId: string): number {
  return store.applyLedger({
    userId,
    amount: -amount,
    reason: "table_buyin",
    refType: "table",
    refId: tableId,
  });
}

/** Return remaining table chips to the wallet on leave. */
export function cashOut(store: Store, userId: string, amount: number, tableId: string): number {
  if (amount <= 0) return store.getBalance(userId);
  return store.applyLedger({
    userId,
    amount,
    reason: "table_cashout",
    refType: "table",
    refId: tableId,
  });
}
