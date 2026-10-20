import { TABLE_KINDS } from "@cute-poker/shared";
import type { TableDef } from "./table.js";

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  publicDir: string;
  /** Short delays make tests instant; production uses lifelike pacing. */
  fast: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    dbPath: env.DB_PATH ?? "./cute-poker.db",
    publicDir: env.PUBLIC_DIR ?? new URL("../../web/public", import.meta.url).pathname,
    fast: env.FAST_MODE === "1",
  };
}

/**
 * The tables that are always available in the lobby (SPEC §3.3). The practice
 * table runs non-stop, filled with bots so a user can play at any hour
 * (SPEC §9.4.1, §11 completion condition).
 */
export function defaultTables(): TableDef[] {
  const k = TABLE_KINDS;
  return [
    {
      id: "practice-1",
      name: "れんしゅう卓 (Practice)",
      kind: "practice",
      sb: k.practice!.sb,
      bb: k.practice!.bb,
      minBuyIn: k.practice!.minBuyIn,
      maxBuyIn: k.practice!.maxBuyIn,
      maxSeats: k.practice!.maxSeats,
      botFill: "always",
    },
    {
      id: "hiyoko-1",
      name: "ひよこテーブル (Hiyoko)",
      kind: "hiyoko",
      sb: k.hiyoko!.sb,
      bb: k.hiyoko!.bb,
      minBuyIn: k.hiyoko!.minBuyIn,
      maxBuyIn: k.hiyoko!.maxBuyIn,
      maxSeats: k.hiyoko!.maxSeats,
      botFill: "backfill",
    },
    {
      id: "usagi-1",
      name: "うさぎテーブル (Usagi)",
      kind: "usagi",
      sb: k.usagi!.sb,
      bb: k.usagi!.bb,
      minBuyIn: k.usagi!.minBuyIn,
      maxBuyIn: k.usagi!.maxBuyIn,
      maxSeats: k.usagi!.maxSeats,
      botFill: "none",
    },
    {
      id: "dragon-1",
      name: "ドラゴンテーブル (Dragon)",
      kind: "dragon",
      sb: k.dragon!.sb,
      bb: k.dragon!.bb,
      minBuyIn: k.dragon!.minBuyIn,
      maxBuyIn: k.dragon!.maxBuyIn,
      maxSeats: k.dragon!.maxSeats,
      botFill: "none",
    },
  ];
}
