/** Domain records and the persistence contract (SPEC §8). */

export interface User {
  id: string;
  displayName: string;
  email: string | null;
  isBot: boolean;
  botDifficulty: "easy" | "normal" | "hard" | null;
  avatarEmoji: string;
  timezone: string;
  createdAt: number;
}

export interface LedgerEntry {
  userId: string;
  amount: number; // + gain / - spend
  reason: string;
  refType?: string;
  refId?: string;
  meta?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DailyLoginResult {
  alreadyClaimed: boolean;
  streak: number;
  reward: number;
  balance: number;
}

export interface HandHistoryRecord {
  id: string;
  tableId: string;
  handNumber: number;
  startedAt: number;
  players: unknown;
  actions: unknown;
  board: unknown;
  potResults: unknown;
  botsPresent: boolean;
  reflectionFactor: number;
}

export interface CoinSinkRecord {
  handId: string;
  userId: string;
  rawAmount: number;
  factor: number;
  destroyedAmount: number;
}

/**
 * Persistence contract. The SQLite implementation is used by default; a
 * Supabase/Postgres implementation can be dropped in later (SPEC §2) by
 * satisfying this interface.
 */
export interface Store {
  createUser(u: Omit<User, "createdAt"> & { createdAt?: number }): User;
  getUser(id: string): User | null;
  getUserByToken(token: string): User | null;
  createAuthToken(userId: string): string;

  getBalance(userId: string): number;

  /**
   * Apply a balance change atomically through the ledger. Throws on
   * insufficient funds. Idempotent when an idempotencyKey is supplied (a
   * repeat returns the balance unchanged). Returns the new balance.
   */
  applyLedger(entry: LedgerEntry): number;

  /** Grant the daily login bonus for the user's local date, once per day. */
  claimDailyLogin(userId: string, localDate: string): DailyLoginResult;

  recordHand(h: HandHistoryRecord): void;
  recordCoinSink(s: CoinSinkRecord): void;

  /** Count all bot users (to decide whether seed bots must be created). */
  listBots(): User[];

  close(): void;
}
