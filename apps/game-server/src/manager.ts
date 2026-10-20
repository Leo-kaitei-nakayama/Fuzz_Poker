import type { WebSocket } from "ws";
import type { ServerMessage } from "@cute-poker/shared";
import { Table, type TableDef, type TableHooks } from "./table.js";
import type { Store } from "./store/types.js";

export interface Pacing {
  botDelayMs(rng: () => number): number;
  interHandMs(): number;
  turnTimeoutMs(): number;
}

export function pacing(fast: boolean): Pacing {
  if (fast) {
    return {
      botDelayMs: () => 3,
      interHandMs: () => 8,
      // Long enough that humans never auto-fold during a test.
      turnTimeoutMs: () => 60_000,
    };
  }
  return {
    // 2-8s lifelike reaction time (SPEC §9.4.4).
    botDelayMs: (rng) => 2_000 + Math.floor(rng() * 6_000),
    interHandMs: () => 3_500,
    turnTimeoutMs: () => 20_000, // SPEC §3.2
  };
}

export interface Conn {
  ws: WebSocket;
  userId: string;
  displayName: string;
  tableId: string | null;
}

/**
 * Owns the live tables and the set of connections watching each one, and wires
 * the per-table hooks that push per-viewer state and broadcast events.
 */
export class GameManager {
  private tables = new Map<string, Table>();
  private watchers = new Map<string, Set<Conn>>();
  private pace: Pacing;

  constructor(
    private store: Store,
    defs: TableDef[],
    fast: boolean,
    private rng: () => number = Math.random,
  ) {
    this.pace = pacing(fast);
    for (const def of defs) this.createTable(def);
  }

  private createTable(def: TableDef): void {
    const hooks: TableHooks = {
      now: () => Date.now(),
      setTimer: (ms, fn) => {
        const h = setTimeout(fn, ms);
        return () => clearTimeout(h);
      },
      rng: this.rng,
      emitState: () => this.pushState(def.id),
      emitEvent: (msg) => this.broadcast(def.id, msg),
      botDelayMs: () => this.pace.botDelayMs(this.rng),
      interHandMs: () => this.pace.interHandMs(),
      turnTimeoutMs: () => this.pace.turnTimeoutMs(),
    };
    const table = new Table(def, this.store, hooks);
    this.tables.set(def.id, table);
    this.watchers.set(def.id, new Set());
    // Kick the practice table into life immediately (bots will fill it).
    table.maybeStartHand();
  }

  getTable(id: string): Table | undefined {
    return this.tables.get(id);
  }

  listTables(): { def: TableDef; occupied: number; botsPresent: boolean; phase: string }[] {
    return [...this.tables.values()].map((t) => {
      const view = t.snapshotFor(null);
      return {
        def: t.def,
        occupied: view.seats.length,
        botsPresent: view.botsPresent,
        phase: view.phase,
      };
    });
  }

  // ---- connection <-> table wiring --------------------------------------

  attach(conn: Conn, tableId: string): void {
    this.detach(conn);
    const set = this.watchers.get(tableId);
    if (!set) return;
    set.add(conn);
    conn.tableId = tableId;
    this.send(conn, { t: "tableState", table: this.tables.get(tableId)!.snapshotFor(conn.userId) });
  }

  detach(conn: Conn): void {
    if (conn.tableId) {
      this.watchers.get(conn.tableId)?.delete(conn);
    }
  }

  pushState(tableId: string): void {
    const table = this.tables.get(tableId);
    const set = this.watchers.get(tableId);
    if (!table || !set) return;
    for (const conn of set) {
      this.send(conn, { t: "tableState", table: table.snapshotFor(conn.userId) });
    }
  }

  broadcast(tableId: string, msg: ServerMessage): void {
    const set = this.watchers.get(tableId);
    if (!set) return;
    for (const conn of set) this.send(conn, msg);
  }

  send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }
}
