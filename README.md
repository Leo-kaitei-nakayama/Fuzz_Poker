# Cute Poker

Online Texas Hold'em with a cute character-collection twist, built
**server-authoritative** (the server is always the source of truth for game
state — SPEC §0.3). See [`SPEC.md`](./SPEC.md) for the full product spec and
[`DECISIONS.md`](./DECISIONS.md) for implementation choices.

> This repository is being built **Phase 1 first**, in the order the spec
> mandates (§15): the pure poker engine, then the game server, then the web app.

## Status

| Area | Package | State |
|---|---|---|
| Pure poker logic | `packages/poker-engine` | ✅ **Implemented & tested** (deck, hand evaluator, betting, side pots, full hand state machine) |
| Shared types / constants | `packages/shared` | ✅ Implemented (cards, game state, economy constants) |
| Bot (AI) players | `packages/poker-bot` | ⬜ Not started (Phase 1, next) |
| WebSocket game server | `apps/game-server` | ⬜ Not started (Phase 1, next) |
| Web client (Next.js) | `apps/web` | ⬜ Not started (Phase 1, later) |
| Auth, DB, coin ledger | `supabase/` | ⬜ Not started (Phase 1, later) |

The poker engine is the foundation everything else depends on and the spec's
required first deliverable; it is complete and fully tested. The remaining
Phase 1 items are the planned next steps.

## Requirements

- Node.js ≥ 22
- pnpm ≥ 10 (`corepack enable` or `npm i -g pnpm`)

## Setup

```bash
pnpm install
```

## Commands

```bash
pnpm test          # run all package test suites
pnpm typecheck     # type-check every package
pnpm build         # emit compiled JS + .d.ts for each package

# engine-specific
pnpm --filter @cute-poker/poker-engine test
pnpm --filter @cute-poker/poker-engine coverage   # enforces SPEC §13's ≥90% bar
pnpm --filter @cute-poker/poker-engine test:watch
```

## The poker engine (`packages/poker-engine`)

Pure, dependency-free game logic (SPEC §9.1). No network, no database, no
clocks — just `(state, action) → newState`, which makes it exhaustively
testable.

```ts
import { startHand, applyAction, legalActions } from "@cute-poker/poker-engine";

let state = startHand({
  players: [
    { id: "alice", seat: 0, stack: 1000 },
    { id: "bob", seat: 1, stack: 1000 },
  ],
  buttonSeat: 0,
  sb: 10,
  bb: 20,
  handNumber: 1,
  // deck omitted -> cryptographically shuffled (SPEC §9.3)
});

const options = legalActions(state);     // { seat, types, callAmount, raise }
state = applyAction(state, { type: "call" });
state = applyAction(state, { type: "check" });
// ...play to HAND_END; state.results holds the pot breakdown
```

Modules:

- `deck.ts` — 52-card deck, Fisher–Yates shuffle over `crypto.randomInt`
  (SPEC §9.3); an injectable seeded RNG is provided for deterministic tests.
- `evaluator.ts` — 7→best-5 hand evaluation, royal flush down to high card,
  including the A-2-3-4-5 wheel; comparable `{ category, tiebreakers }` values.
- `betting.ts` — legal actions, min-raise bounds, round-completion, the
  short-all-in re-open rule.
- `pots.ts` — main/side-pot construction and split/odd-chip distribution.
- `game.ts` — the hand state machine (`WAITING → PREFLOP → … → HAND_END`),
  blinds, positions, street progression, all-in run-outs, settlement.

### Tests (SPEC §9.2 acceptance criteria)

All of the spec's required engine tests are implemented and passing:

- Every hand ranking, the wheel, same-rank kicker comparison, and board-plays
  ties → split pots.
- Side pots with 3+ players and staged all-ins.
- Heads-up blind posting and action order (pre- and post-flop).
- Minimum raise and short all-in (a sub-full all-in grants no re-raise right).
- **Property test**: thousands of random hands verifying total chips are
  conserved at every step.

```
Test Files  6 passed (6)
Tests       64 passed (64)
Coverage    ~96% lines (≥90% required by SPEC §13)
```

## Repository layout

```
packages/
  poker-engine/   pure poker logic (UI/DB independent)   ← done
  shared/         types, constants, (later) zod schemas  ← done
apps/
  game-server/    WebSocket server (planned)
  web/            Next.js client (planned)
SPEC.md DECISIONS.md README.md
```

## Next steps (remaining Phase 1)

1. `packages/poker-bot` — Easy & Normal bots (SPEC §9.4), pure `(state) → action`.
2. `apps/game-server` — table management, WebSocket protocol (SPEC §10), turn
   timer, disconnect handling, always-on practice tables filled with bots.
3. Coin reflection ×0.2 for bot hands + `coin_sink` ledger (SPEC §4.5).
4. `apps/web` + Supabase auth, wallet/ledger, daily-login rewards, lobby & table UI.

See the full Phase 1 checklist and acceptance conditions in `SPEC.md` §11.
