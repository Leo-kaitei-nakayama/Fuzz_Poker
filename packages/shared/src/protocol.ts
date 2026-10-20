import { z } from "zod";
import type { Card } from "./cards.js";
import type { ActionType, Phase } from "./game.js";

/**
 * Realtime protocol (SPEC §10). Client -> server messages are validated with
 * zod (never trust the client, §0.3). Server -> client messages are typed but
 * produced by the authoritative server, so they are not re-validated.
 */

// --------------------------------------------------------------------------
// Client -> server
// --------------------------------------------------------------------------

export const JoinTableMsg = z.object({
  t: z.literal("joinTable"),
  tableId: z.string().min(1),
  buyIn: z.number().int().positive(),
  seat: z.number().int().min(0).max(5).optional(),
});

export const LeaveTableMsg = z.object({ t: z.literal("leaveTable") });

export const ActionMsg = z.object({
  t: z.literal("action"),
  action: z.enum(["fold", "check", "call", "raise", "allin"]),
  amount: z.number().int().nonnegative().optional(),
});

export const SitOutMsg = z.object({ t: z.literal("sitOut") });
export const SitInMsg = z.object({ t: z.literal("sitIn") });

export const ChatMsg = z.object({
  t: z.literal("chat"),
  text: z.string().min(1).max(200),
});

export const PingMsg = z.object({ t: z.literal("ping") });

export const ClientMessage = z.discriminatedUnion("t", [
  JoinTableMsg,
  LeaveTableMsg,
  ActionMsg,
  SitOutMsg,
  SitInMsg,
  ChatMsg,
  PingMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --------------------------------------------------------------------------
// Server -> client view types (opponents' hole cards are hidden, SPEC §9.3)
// --------------------------------------------------------------------------

export interface SeatView {
  seat: number;
  userId: string;
  displayName: string;
  avatarEmoji: string;
  isBot: boolean;
  stack: number;
  committedThisStreet: number;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  inHand: boolean;
  /** Only present for the receiving player, or at showdown. */
  holeCards: Card[] | null;
  isTurn: boolean;
}

export interface TableView {
  tableId: string;
  name: string;
  kind: string;
  sb: number;
  bb: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxSeats: number;
  /** True when any seat in the current hand is a bot (drives the 🤖 badge). */
  botsPresent: boolean;
  /** True when this hand's winnings will be compressed x0.2 (SPEC §4.5). */
  reflectionFactor: number;
  phase: Phase;
  handNumber: number;
  buttonSeat: number | null;
  board: Card[];
  pot: number;
  currentBet: number;
  toActSeat: number | null;
  /** Server time (ms since epoch) when the current actor times out. */
  actionDeadline: number | null;
  seats: SeatView[];
  /** The receiving player's own seat, if seated. */
  yourSeat: number | null;
  /** Legal actions for the receiving player when it is their turn. */
  yourLegal: {
    types: ActionType[];
    callAmount: number;
    minRaiseTo: number | null;
    maxRaiseTo: number | null;
  } | null;
}

export interface PotResultView {
  amount: number;
  winners: string[];
  payouts: Record<string, number>;
}

/** Per-player wallet reflection detail for a finished hand (SPEC §4.5). */
export interface HandReflectionView {
  userId: string;
  displayName: string;
  /** Net chips at the table this hand (won - wagered). */
  rawDelta: number;
  factor: number;
  /** What actually hit the wallet after x-factor compression. */
  walletDelta: number;
}

export interface ShowdownView {
  board: Card[];
  reveals: { seat: number; userId: string; holeCards: Card[]; handName: string }[];
  pots: PotResultView[];
}

export type ServerMessage =
  | { t: "tableState"; table: TableView }
  | { t: "handStarted"; handNumber: number; botsPresent: boolean; reflectionFactor: number }
  | { t: "actionRequired"; seat: number; deadline: number }
  | { t: "actionApplied"; seat: number; action: ActionType; amount: number }
  | { t: "phaseChanged"; phase: Phase; board: Card[] }
  | { t: "showdown"; showdown: ShowdownView }
  | {
      t: "handResult";
      pots: PotResultView[];
      reflections: HandReflectionView[];
      reflectionFactor: number;
      botsPresent: boolean;
    }
  | { t: "playerJoined"; seat: number; displayName: string; isBot: boolean }
  | { t: "playerLeft"; seat: number }
  | { t: "chat"; seat: number; displayName: string; text: string }
  | { t: "wallet"; balance: number }
  | { t: "error"; code: string; message: string }
  | { t: "pong" };
