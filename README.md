# Cute Poker 🎴

Online Texas Hold'em with a cute character-collection twist, built
**server-authoritative** (the server is always the source of truth — SPEC §0.3).
See [`SPEC.md`](./SPEC.md) for the full product spec and
[`DECISIONS.md`](./DECISIONS.md) for implementation choices.

**Phase 1 (the MVP) is complete and playable end-to-end**: you can open the web
client, get coins, sit at a table, and play real hands of no-limit hold'em
against bots at any hour — with winnings from bot hands compressed ×0.2 and
shown transparently (SPEC §4.5, §11).

![table](https://img.shields.io/badge/status-Phase_1_complete-7CC6A4)

## What works (SPEC §11 completion conditions)

- ✅ **Play a full hand in the browser** against other players and bots.
- ✅ **0-player hours are covered** — the practice table is always running,
  filled with bots; a human can sit down any time and bots make room.
- ✅ **Chip totals are conserved**; the coin ledger balance always equals the
  sum of its transactions and never goes negative (SPEC §4.4).
- ✅ **Bot-hand winnings reflect ×0.2** into the wallet, the destroyed chips are
  recorded to `coin_sink`, and the compression is shown in the UI (SPEC §4.5).
- ✅ **Hand history is persisted** to the database.
- ✅ Signup bonus (5,000), daily-login streak rewards, buy-in/cash-out,
  turn timers, disconnect auto-fold + reconnect, chat with an NG-word filter,
  responsive phone layout, ja/en UI.

## Architecture

A single deployable Node service hosts everything (SPEC §2 notes a WebSocket
server must be a long-lived process; bundling the static client with it is the
simplest thing to actually put online):

```
packages/
  poker-engine/   pure poker logic — deck, evaluator, betting, pots, state machine
  poker-bot/      pure bot decisions (Easy / Normal) — (state) -> action
  shared/         types, constants, zod WS protocol schemas
apps/
  game-server/    HTTP + WebSocket server, tables, bots, economy, SQLite store
  web/            responsive single-page client (bundled, served by game-server)
supabase/         PostgreSQL schema for the eventual managed DB (SPEC §8)
Dockerfile · fly.toml · .env.example
```

The store is an interface (`apps/game-server/src/store`) with an embedded
**SQLite** implementation (via Node's built-in `node:sqlite`, giving real ACID
transactions for the coin ledger) so the whole thing runs with **zero external
services**. Swap in a Supabase/Postgres implementation later using
[`supabase/schema.sql`](./supabase/schema.sql).

## Requirements

- Node.js ≥ 22 (uses the built-in `node:sqlite`)
- pnpm ≥ 10 (`corepack enable`)

## Run it locally

```bash
pnpm install
pnpm start          # builds everything, then serves on http://localhost:8080
```

Open http://localhost:8080, click **ゲストで遊ぶ / Play as guest**, press
**🎁 Daily bonus**, then join **れんしゅう卓 (Practice)** and play. Open a second
browser (or an incognito window) to sit at the same table as a second human.

Development with live rebuilds:

```bash
pnpm dev            # web client rebuilt once + server with tsx watch
```

## Commands

```bash
pnpm test           # all package + server test suites
pnpm typecheck      # type-check every package
pnpm build          # build web bundle + single-file server bundle

pnpm --filter @cute-poker/poker-engine coverage   # engine coverage (SPEC §13 ≥90%)
```

### Tests

```
poker-engine   44 tests   ~96% line coverage   (hand ranking, side pots,
                                                 heads-up order, short all-in,
                                                 chip-conservation property test)
poker-bot       7 tests   (always-legal actions, preflop discipline)
game-server    10 tests   (ledger integrity, daily login, and a full WebSocket
                           hand vs bots asserting the ×0.2 reflection)
```

Run everything: `pnpm test`.

## Deploy

The repo builds a single container (HTTP + WebSocket + static client + SQLite):

```bash
docker build -t cute-poker .
docker run -p 8080:8080 -v cutepoker:/data cute-poker
```

- **Fly.io**: [`fly.toml`](./fly.toml) is ready — `fly launch --no-deploy` then
  `fly deploy`. It keeps one machine running 24/7 so the practice bots never
  sleep, with a volume for the SQLite database.
- **Railway / Render**: point them at the `Dockerfile`, expose port 8080, and
  attach a persistent volume at `/data`.

Configuration is via env vars — see [`.env.example`](./.env.example).

> Not in this build (by design, deferred per the spec): real-money anything
> (never — SPEC §12), Supabase email/Google auth (guest accounts are used for
> now), and Phases 2–4 (characters/shop, trading, ads). See the roadmap below.

## Roadmap

- **Phase 2** — characters & shop, collection/図鑑, main-icon avatars, rescue
  bonus, rankings, hiyoko-table bot backfill, invites.
- **Phase 3** — trading (atomic, with fees & anti-abuse), achievements/missions,
  emotes, the Hard bot.
- **Phase 4** — rewarded ads (server-side verified), PWA, polish.

See `SPEC.md` §11 for the full phase breakdown and `DECISIONS.md` for the
rationale behind the Phase 1 choices.
