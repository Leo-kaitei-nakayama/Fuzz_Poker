import { describe, it, expect, beforeEach } from "vitest";
import { SqliteStore, InsufficientFundsError } from "../src/store/sqlite.js";
import { grantSignupBonus } from "../src/economy.js";

function mkUser(store: SqliteStore, id = "u1") {
  return store.createUser({
    id,
    displayName: id,
    email: null,
    isBot: false,
    botDifficulty: null,
    avatarEmoji: "🐱",
    timezone: "UTC",
  });
}

describe("SqliteStore ledger (SPEC §4.4)", () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore(":memory:");
  });

  it("new wallet starts at zero; signup bonus is idempotent", () => {
    mkUser(store);
    expect(store.getBalance("u1")).toBe(0);
    expect(grantSignupBonus(store, "u1")).toBe(5000);
    // Re-granting with the same idempotency key does not double-credit.
    expect(grantSignupBonus(store, "u1")).toBe(5000);
    expect(store.getBalance("u1")).toBe(5000);
  });

  it("balance never goes negative", () => {
    mkUser(store);
    grantSignupBonus(store, "u1");
    expect(() =>
      store.applyLedger({ userId: "u1", amount: -6000, reason: "table_buyin" }),
    ).toThrow(InsufficientFundsError);
    expect(store.getBalance("u1")).toBe(5000); // unchanged after rollback
  });

  it("balance equals the sum of its ledger entries", () => {
    mkUser(store);
    grantSignupBonus(store, "u1");
    store.applyLedger({ userId: "u1", amount: -400, reason: "table_buyin" });
    store.applyLedger({ userId: "u1", amount: 150, reason: "table_cashout" });
    expect(store.getBalance("u1")).toBe(5000 - 400 + 150);
  });

  it("daily login grants streak rewards and is once-per-day", () => {
    mkUser(store);
    const d1 = store.claimDailyLogin("u1", "2026-01-01");
    expect(d1).toMatchObject({ alreadyClaimed: false, streak: 1, reward: 500 });
    // Same day again -> already claimed, no extra coins.
    const again = store.claimDailyLogin("u1", "2026-01-01");
    expect(again.alreadyClaimed).toBe(true);
    expect(store.getBalance("u1")).toBe(500);

    const d2 = store.claimDailyLogin("u1", "2026-01-02");
    expect(d2).toMatchObject({ streak: 2, reward: 600 });

    // Skipping a day resets the streak to day 1.
    const d4 = store.claimDailyLogin("u1", "2026-01-04");
    expect(d4.streak).toBe(1);
    expect(d4.reward).toBe(500);
  });

  it("auth tokens resolve back to the user", () => {
    mkUser(store);
    const token = store.createAuthToken("u1");
    expect(store.getUserByToken(token)?.id).toBe("u1");
    expect(store.getUserByToken("nope")).toBeNull();
  });
});
