import { createServer as createHttpServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessage, type ServerMessage } from "@cute-poker/shared";
import { SqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/types.js";
import { GameManager, type Conn } from "./manager.js";
import { defaultTables, type ServerConfig } from "./config.js";
import { buyIn, cashOut, grantSignupBonus } from "./economy.js";
import { TableError } from "./table.js";
import { filterChat, randomEmoji, TokenBucket } from "./util.js";
import { readBody, sendJson, serveStatic } from "./http.js";

export interface RunningServer {
  http: Server;
  manager: GameManager;
  store: Store;
  port: number;
  /** Resolves once the HTTP server is bound and accepting connections. */
  ready: Promise<void>;
  close(): Promise<void>;
}

interface ConnState {
  conn: Conn;
  actionBucket: TokenBucket;
  chatBucket: TokenBucket;
}

const GRACE_MS = 30_000;

export function createServer(
  config: ServerConfig,
  storeOverride?: Store,
): RunningServer {
  const store = storeOverride ?? new SqliteStore(config.dbPath);
  const manager = new GameManager(store, defaultTables(), config.fast);

  const conns = new Map<WebSocket, ConnState>();
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const graceKey = (userId: string, tableId: string) => `${userId}@${tableId}`;

  // ---- HTTP (auth, lobby, static) --------------------------------------

  const http = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        await handleApi(req, res, path, store, manager);
        return;
      }

      // Static client.
      const handled = await serveStatic(config.publicDir, req.url ?? "/", res);
      if (!handled) sendJson(res, 404, { error: "not_found" });
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
    }
  });

  // ---- WebSocket --------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? "";
    const user = store.getUserByToken(token);
    if (!user) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Conn = {
        ws,
        userId: user.id,
        displayName: user.displayName,
        tableId: null,
      };
      const state: ConnState = {
        conn,
        actionBucket: new TokenBucket(12, 8),
        chatBucket: new TokenBucket(3, 0.5),
      };
      conns.set(ws, state);
      send(conn, { t: "wallet", balance: store.getBalance(user.id) });

      ws.on("message", (raw) => handleMessage(state, raw.toString()));
      ws.on("close", () => handleClose(state));
      ws.on("error", () => ws.close());
    });
  });

  function send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  function handleMessage(state: ConnState, raw: string): void {
    const { conn } = state;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(conn, { t: "error", code: "bad_json", message: "Malformed message" });
      return;
    }
    const result = ClientMessage.safeParse(parsed);
    if (!result.success) {
      send(conn, { t: "error", code: "bad_message", message: "Invalid message" });
      return;
    }
    const msg = result.data;

    try {
      switch (msg.t) {
        case "ping":
          send(conn, { t: "pong" });
          break;
        case "joinTable":
          onJoin(state, msg.tableId, msg.buyIn, msg.seat);
          break;
        case "leaveTable":
          onLeave(conn);
          break;
        case "action": {
          if (!state.actionBucket.tryRemove()) {
            send(conn, { t: "error", code: "rate_limited", message: "Slow down" });
            break;
          }
          const table = conn.tableId ? manager.getTable(conn.tableId) : undefined;
          if (!table) {
            send(conn, { t: "error", code: "no_table", message: "Not at a table" });
            break;
          }
          table.handleAction(conn.userId, { action: msg.action, amount: msg.amount });
          break;
        }
        case "sitOut":
        case "sitIn": {
          const table = conn.tableId ? manager.getTable(conn.tableId) : undefined;
          table?.sitOut(conn.userId, msg.t === "sitOut");
          break;
        }
        case "chat": {
          if (!state.chatBucket.tryRemove()) break;
          const table = conn.tableId ? manager.getTable(conn.tableId) : undefined;
          if (!table) break;
          const seat = table.findSeatByUser(conn.userId);
          if (!seat) break;
          manager.broadcast(conn.tableId!, {
            t: "chat",
            seat: seat.seat,
            displayName: conn.displayName,
            text: filterChat(msg.text),
          });
          break;
        }
      }
    } catch (e) {
      const err = e as TableError;
      send(conn, { t: "error", code: err.code ?? "error", message: err.message });
    }
  }

  function onJoin(state: ConnState, tableId: string, amount: number, seat?: number): void {
    const { conn } = state;
    const table = manager.getTable(tableId);
    if (!table) {
      send(conn, { t: "error", code: "no_table", message: "Unknown table" });
      return;
    }

    // Reconnect to an existing seat: reattach without buying in again.
    const existing = table.findSeatByUser(conn.userId);
    if (existing) {
      const timer = graceTimers.get(graceKey(conn.userId, tableId));
      if (timer) {
        clearTimeout(timer);
        graceTimers.delete(graceKey(conn.userId, tableId));
      }
      manager.attach(conn, tableId);
      table.setConnected(conn.userId, true);
      return;
    }

    const def = table.def;
    if (amount < def.minBuyIn || amount > def.maxBuyIn) {
      send(conn, {
        t: "error",
        code: "bad_buyin",
        message: `Buy-in must be between ${def.minBuyIn} and ${def.maxBuyIn}`,
      });
      return;
    }
    const balance = store.getBalance(conn.userId);
    if (balance < amount) {
      send(conn, { t: "error", code: "insufficient", message: "Not enough coins" });
      return;
    }

    try {
      const newBalance = buyIn(store, conn.userId, amount, tableId);
      table.seatPlayer(
        {
          userId: conn.userId,
          displayName: conn.displayName,
          avatarEmoji: store.getUser(conn.userId)?.avatarEmoji ?? "🐱",
          isBot: false,
        },
        amount,
        seat,
      );
      manager.attach(conn, tableId);
      send(conn, { t: "wallet", balance: newBalance });
    } catch (e) {
      const err = e as TableError;
      // Refund if seating failed after the buy-in was taken.
      if (err.name === "TableError") {
        cashOut(store, conn.userId, amount, tableId);
        send(conn, { t: "wallet", balance: store.getBalance(conn.userId) });
      }
      send(conn, { t: "error", code: err.code ?? "join_failed", message: err.message });
    }
  }

  function onLeave(conn: Conn): void {
    if (!conn.tableId) return;
    const table = manager.getTable(conn.tableId);
    if (table) {
      const remaining = table.removePlayer(conn.userId);
      if (remaining > 0) cashOut(store, conn.userId, remaining, conn.tableId);
      send(conn, { t: "wallet", balance: store.getBalance(conn.userId) });
    }
    manager.detach(conn);
    conn.tableId = null;
  }

  function handleClose(state: ConnState): void {
    const { conn } = state;
    conns.delete(conn.ws);
    const tableId = conn.tableId;
    manager.detach(conn);
    if (!tableId) return;
    const table = manager.getTable(tableId);
    if (!table) return;

    // If the user still has another open connection here, do nothing.
    const stillHere = [...conns.values()].some(
      (s) => s.conn.userId === conn.userId && s.conn.tableId === tableId,
    );
    if (stillHere) return;

    table.setConnected(conn.userId, false);

    // Grace period, then cash out and free the seat (SPEC §3.2 reconnect).
    const key = graceKey(conn.userId, tableId);
    const timer = setTimeout(() => {
      graceTimers.delete(key);
      const reconnected = [...conns.values()].some(
        (s) => s.conn.userId === conn.userId && s.conn.tableId === tableId,
      );
      if (reconnected) return;
      const remaining = table.removePlayer(conn.userId);
      if (remaining > 0) cashOut(store, conn.userId, remaining, tableId);
    }, config.fast ? 400 : GRACE_MS);
    graceTimers.set(key, timer);
  }

  let actualPort = config.port;
  const ready = new Promise<void>((resolve) => {
    http.listen(config.port, config.host, () => {
      const addr = http.address();
      if (addr && typeof addr === "object") actualPort = addr.port;
      resolve();
    });
  });

  return {
    http,
    manager,
    store,
    ready,
    get port() {
      const addr = http.address();
      return addr && typeof addr === "object" ? addr.port : actualPort;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of graceTimers.values()) clearTimeout(timer);
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        http.close(() => {
          if (!storeOverride) store.close();
          resolve();
        });
      }),
  };
}

// ---- REST handlers -------------------------------------------------------

async function handleApi(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  path: string,
  store: Store,
  manager: GameManager,
): Promise<void> {
  const method = req.method ?? "GET";

  if (path === "/api/guest" && method === "POST") {
    const body = (await readBody(req)) as { displayName?: string; timezone?: string };
    const id = randomUUID();
    const displayName =
      (body.displayName ?? "").trim().slice(0, 20) || `ゲスト-${id.slice(0, 4)}`;
    const user = store.createUser({
      id,
      displayName,
      email: null,
      isBot: false,
      botDifficulty: null,
      avatarEmoji: randomEmoji(),
      timezone: body.timezone ?? "UTC",
    });
    grantSignupBonus(store, id);
    const token = store.createAuthToken(id);
    sendJson(res, 200, { token, user, balance: store.getBalance(id) });
    return;
  }

  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const user = token ? store.getUserByToken(token) : null;

  if (path === "/api/lobby" && method === "GET") {
    sendJson(res, 200, {
      tables: manager.listTables().map((t) => ({
        id: t.def.id,
        name: t.def.name,
        kind: t.def.kind,
        sb: t.def.sb,
        bb: t.def.bb,
        minBuyIn: t.def.minBuyIn,
        maxBuyIn: t.def.maxBuyIn,
        maxSeats: t.def.maxSeats,
        occupied: t.occupied,
        botsPresent: t.botsPresent,
        phase: t.phase,
      })),
    });
    return;
  }

  if (!user) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (path === "/api/me" && method === "GET") {
    sendJson(res, 200, { user, balance: store.getBalance(user.id) });
    return;
  }

  if (path === "/api/daily" && method === "POST") {
    const body = (await readBody(req)) as { localDate?: string };
    const localDate = body.localDate ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      sendJson(res, 400, { error: "bad_date" });
      return;
    }
    const result = store.claimDailyLogin(user.id, localDate);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}
