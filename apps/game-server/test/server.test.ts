import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage, TableView } from "@cute-poker/shared";
import { SqliteStore } from "../src/store/sqlite.js";
import { createServer, type RunningServer } from "../src/server.js";

let server: RunningServer;
let store: SqliteStore;
let base: string;

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  server = createServer(
    { port: 0, host: "127.0.0.1", dbPath: ":memory:", publicDir: "/nonexistent", fast: true },
    store,
  );
  await server.ready;
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  store.close();
});

async function guest(name: string): Promise<{ token: string; userId: string; balance: number }> {
  const res = await fetch(`${base}/api/guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: name }),
  });
  const data = (await res.json()) as { token: string; user: { id: string }; balance: number };
  return { token: data.token, userId: data.user.id, balance: data.balance };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  send(msg: unknown): void;
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, ms?: number): Promise<T>;
  close(): void;
}

function connect(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`);
    const messages: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
      [];

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(msg)) {
          waiters[i]!.resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        messages,
        send: (msg) => ws.send(JSON.stringify(msg)),
        waitFor: (pred, ms = 8000) =>
          new Promise((res, rej) => {
            const existing = messages.find(pred);
            if (existing) return res(existing as never);
            const timer = setTimeout(() => rej(new Error("waitFor timeout")), ms);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(timer);
                res(m as never);
              },
            });
          }),
        close: () => ws.close(),
      }),
    );
  });
}

describe("REST", () => {
  it("creates a guest with the 5000 signup bonus", async () => {
    const g = await guest("Tester");
    expect(g.balance).toBe(5000);
  });

  it("grants the daily login bonus once", async () => {
    const g = await guest("Daily");
    const res = await fetch(`${base}/api/daily`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${g.token}` },
      body: JSON.stringify({ localDate: "2026-02-01" }),
    });
    const data = (await res.json()) as { reward: number; balance: number };
    expect(data.reward).toBe(500);
    expect(data.balance).toBe(5500);
  });

  it("lists the always-on lobby tables including the bot practice table", async () => {
    const res = await fetch(`${base}/api/lobby`);
    const data = (await res.json()) as { tables: { id: string; kind: string }[] };
    const practice = data.tables.find((t) => t.id === "practice-1");
    expect(practice?.kind).toBe("practice");
    expect(data.tables.map((t) => t.kind)).toEqual(
      expect.arrayContaining(["practice", "hiyoko", "usagi", "dragon"]),
    );
  });
});

describe("playing a hand against bots (SPEC §11 completion)", () => {
  it("joins the practice table, plays a hand, and reflects winnings x0.2", async () => {
    const g = await guest("Hero");
    const client = await connect(g.token);

    client.send({ t: "joinTable", tableId: "practice-1", buyIn: 1000 });

    // Auto-pilot: whenever it is our turn, take the simplest legal action.
    client.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.t !== "tableState") return;
      const tv = msg.table as TableView;
      if (tv.yourSeat !== null && tv.toActSeat === tv.yourSeat && tv.yourLegal) {
        const types = tv.yourLegal.types;
        const action = types.includes("check")
          ? "check"
          : types.includes("call")
            ? "call"
            : "fold";
        client.send({ t: "action", action });
      }
    });

    // Wait for a hand result in which we were dealt in (our reflection present).
    const result = await client.waitFor(
      (m): m is Extract<ServerMessage, { t: "handResult" }> =>
        m.t === "handResult" && m.reflections.some((r) => r.userId === g.userId),
      12000,
    );

    expect(result.botsPresent).toBe(true);
    expect(result.reflectionFactor).toBe(0.2);

    const mine = result.reflections.find((r) => r.userId === g.userId)!;
    // Wallet reflection is exactly the raw chip result compressed x0.2.
    expect(mine.factor).toBe(0.2);
    expect(mine.walletDelta).toBe(Math.round(mine.rawDelta * 0.2));

    client.close();
  }, 15000);

  it("supports two independent clients watching the same table", async () => {
    const a = await guest("A");
    const b = await guest("B");
    const ca = await connect(a.token);
    const cb = await connect(b.token);

    ca.send({ t: "joinTable", tableId: "practice-1", buyIn: 500 });
    cb.send({ t: "joinTable", tableId: "practice-1", buyIn: 500 });

    const stateB = await cb.waitFor(
      (m): m is Extract<ServerMessage, { t: "tableState" }> =>
        m.t === "tableState" && m.table.botsPresent,
    );
    expect(stateB.table.botsPresent).toBe(true);
    expect(stateB.table.seats.length).toBeGreaterThanOrEqual(2);

    ca.close();
    cb.close();
  }, 15000);
});
