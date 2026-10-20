import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

// Load node:sqlite at runtime so bundlers/test runners that don't recognise
// this newer builtin don't try to resolve it at transform time.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
import { DAILY_LOGIN_REWARDS } from "@cute-poker/shared";
import type {
  CoinSinkRecord,
  DailyLoginResult,
  HandHistoryRecord,
  LedgerEntry,
  Store,
  User,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  bot_difficulty TEXT,
  avatar_emoji TEXT NOT NULL DEFAULT '🐱',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL CHECK (balance >= 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  meta TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_sink (
  id TEXT PRIMARY KEY,
  hand_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  raw_amount INTEGER NOT NULL,
  factor REAL NOT NULL,
  destroyed_amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_logins (
  user_id TEXT NOT NULL,
  login_date TEXT NOT NULL,
  streak INTEGER NOT NULL,
  reward INTEGER NOT NULL,
  PRIMARY KEY (user_id, login_date)
);
CREATE TABLE IF NOT EXISTS hand_history (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL,
  hand_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  players TEXT NOT NULL,
  actions TEXT NOT NULL,
  board TEXT NOT NULL,
  pot_results TEXT NOT NULL,
  bots_present INTEGER NOT NULL,
  reflection_factor REAL NOT NULL
);
`;

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    email: (r.email as string | null) ?? null,
    isBot: Number(r.is_bot) === 1,
    botDifficulty: (r.bot_difficulty as User["botDifficulty"]) ?? null,
    avatarEmoji: r.avatar_emoji as string,
    timezone: r.timezone as string,
    createdAt: Number(r.created_at),
  };
}

export class SqliteStore implements Store {
  private db: DatabaseSyncType;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  createUser(u: Omit<User, "createdAt"> & { createdAt?: number }): User {
    const createdAt = u.createdAt ?? Date.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO users (id, display_name, email, is_bot, bot_difficulty, avatar_emoji, timezone, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          u.id,
          u.displayName,
          u.email ?? null,
          u.isBot ? 1 : 0,
          u.botDifficulty ?? null,
          u.avatarEmoji,
          u.timezone,
          createdAt,
        );
      this.db
        .prepare(`INSERT INTO wallets (user_id, balance, updated_at) VALUES (?, 0, ?)`)
        .run(u.id, createdAt);
    });
    return { ...u, createdAt };
  }

  getUser(id: string): User | null {
    const r = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToUser(r) : null;
  }

  getUserByToken(token: string): User | null {
    const r = this.db
      .prepare(
        `SELECT u.* FROM users u JOIN auth_tokens t ON t.user_id = u.id WHERE t.token = ?`,
      )
      .get(token) as Record<string, unknown> | undefined;
    return r ? rowToUser(r) : null;
  }

  createAuthToken(userId: string): string {
    const token = randomUUID() + randomUUID().replace(/-/g, "");
    this.db
      .prepare(`INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)`)
      .run(token, userId, Date.now());
    return token;
  }

  getBalance(userId: string): number {
    const r = this.db.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).get(userId) as
      | { balance: number }
      | undefined;
    return r ? Number(r.balance) : 0;
  }

  applyLedger(entry: LedgerEntry): number {
    return this.tx(() => {
      if (entry.idempotencyKey) {
        const existing = this.db
          .prepare(`SELECT balance_after FROM coin_transactions WHERE idempotency_key = ?`)
          .get(entry.idempotencyKey) as { balance_after: number } | undefined;
        if (existing) return Number(existing.balance_after); // already applied
      }

      const walletRow = this.db
        .prepare(`SELECT balance FROM wallets WHERE user_id = ?`)
        .get(entry.userId) as { balance: number } | undefined;
      const current = walletRow ? Number(walletRow.balance) : 0;
      const next = current + entry.amount;
      if (next < 0) {
        throw new InsufficientFundsError(entry.userId, current, entry.amount);
      }

      this.db
        .prepare(`UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ?`)
        .run(next, Date.now(), entry.userId);
      this.db
        .prepare(
          `INSERT INTO coin_transactions
             (id, user_id, amount, balance_after, reason, ref_type, ref_id, meta, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          entry.userId,
          entry.amount,
          next,
          entry.reason,
          entry.refType ?? null,
          entry.refId ?? null,
          entry.meta ? JSON.stringify(entry.meta) : null,
          entry.idempotencyKey ?? null,
          Date.now(),
        );
      return next;
    });
  }

  claimDailyLogin(userId: string, localDate: string): DailyLoginResult {
    return this.tx(() => {
      const existing = this.db
        .prepare(`SELECT reward, streak FROM daily_logins WHERE user_id = ? AND login_date = ?`)
        .get(userId, localDate) as { reward: number; streak: number } | undefined;
      if (existing) {
        return {
          alreadyClaimed: true,
          streak: Number(existing.streak),
          reward: Number(existing.reward),
          balance: this.getBalance(userId),
        };
      }

      // Find the most recent prior login to compute the streak.
      const prior = this.db
        .prepare(
          `SELECT login_date, streak FROM daily_logins WHERE user_id = ? ORDER BY login_date DESC LIMIT 1`,
        )
        .get(userId) as { login_date: string; streak: number } | undefined;

      let streak = 1;
      if (prior) {
        const prev = new Date(prior.login_date + "T00:00:00Z").getTime();
        const today = new Date(localDate + "T00:00:00Z").getTime();
        const dayMs = 86_400_000;
        streak = today - prev === dayMs ? Number(prior.streak) + 1 : 1;
      }
      const reward = DAILY_LOGIN_REWARDS[Math.min(streak - 1, DAILY_LOGIN_REWARDS.length - 1)]!;

      this.db
        .prepare(
          `INSERT INTO daily_logins (user_id, login_date, streak, reward) VALUES (?, ?, ?, ?)`,
        )
        .run(userId, localDate, streak, reward);

      // Credit the wallet in the same transaction (idempotent on date).
      const walletRow = this.db
        .prepare(`SELECT balance FROM wallets WHERE user_id = ?`)
        .get(userId) as { balance: number } | undefined;
      const next = (walletRow ? Number(walletRow.balance) : 0) + reward;
      this.db
        .prepare(`UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ?`)
        .run(next, Date.now(), userId);
      this.db
        .prepare(
          `INSERT INTO coin_transactions
             (id, user_id, amount, balance_after, reason, ref_type, ref_id, meta, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, 'daily_login', 'daily', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          userId,
          reward,
          next,
          localDate,
          JSON.stringify({ streak }),
          `daily:${userId}:${localDate}`,
          Date.now(),
        );

      return { alreadyClaimed: false, streak, reward, balance: next };
    });
  }

  recordHand(h: HandHistoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO hand_history
           (id, table_id, hand_number, started_at, players, actions, board, pot_results, bots_present, reflection_factor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        h.id,
        h.tableId,
        h.handNumber,
        h.startedAt,
        JSON.stringify(h.players),
        JSON.stringify(h.actions),
        JSON.stringify(h.board),
        JSON.stringify(h.potResults),
        h.botsPresent ? 1 : 0,
        h.reflectionFactor,
      );
  }

  recordCoinSink(s: CoinSinkRecord): void {
    this.db
      .prepare(
        `INSERT INTO coin_sink (id, hand_id, user_id, raw_amount, factor, destroyed_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), s.handId, s.userId, s.rawAmount, s.factor, s.destroyedAmount, Date.now());
  }

  listBots(): User[] {
    const rows = this.db.prepare(`SELECT * FROM users WHERE is_bot = 1`).all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToUser);
  }

  close(): void {
    this.db.close();
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    public userId: string,
    public balance: number,
    public attempted: number,
  ) {
    super(`Insufficient funds for ${userId}: balance ${balance}, change ${attempted}`);
    this.name = "InsufficientFundsError";
  }
}
