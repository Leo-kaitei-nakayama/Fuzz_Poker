# DECISIONS.md

Per SPEC §0.4, every point where the spec left a choice open is recorded here
with the option taken and the reasoning. Dated entries, newest first.

---

## 2026-10-20 — Phase 1 completion: bots, server, economy, web client

### Deployment shape: one Node service, not Vercel + separate server
The spec (§2) suggests Next.js on Vercel + a separate WebSocket server. For a
Phase 1 that must actually *go online* simply, a **single Node service** that
serves the static client AND the WebSocket is far easier to host (one process,
one deploy, one volume) and removes cross-origin/session complexity. The web
client is therefore a bundled vanilla-TS SPA (esbuild) served by the game
server, not a Next.js app. This can be revisited when PWA/SSR needs arrive
(Phase 4). The client still imports shared types, keeps strings out of code
behind a tiny i18n dict (ja/en), and is responsive for phone portrait.

### Persistence: embedded SQLite (`node:sqlite`), behind a Store interface
To run with **zero external dependencies** while still having real ACID
transactions for the coin ledger (§4.4) and hand history, the server uses Node's
built-in `node:sqlite`. All persistence sits behind a `Store` interface, so a
`PostgresStore` for Supabase can be dropped in later; the full Postgres schema
is provided in `supabase/schema.sql` (§8, with RLS). `node:sqlite` is loaded via
`createRequire` so bundlers/test runners that don't yet recognise this newer
builtin don't choke on it.

### Auth: guest accounts now, Supabase Auth later
The spec wants Supabase email/Google auth, but §16 leaves "allow guest play?"
open. Fastest path to a playable online game is **guest accounts**: `POST
/api/guest` mints a user + 5,000 bonus + a bearer token kept in localStorage.
Real auth is a Phase-1.5/2 addition that doesn't change the game loop.

### Coin reflection applied to the table stack, not per-hand wallet writes
§4.5's ledger example settles each hand to the wallet with a factor. We instead
keep **buy-in and cash-out at 1:1** and apply the ×0.2 compression to the
**table stack between hands**, recording the destroyed/injected chips to
`coin_sink`. Because cash-out returns the (already-compressed) stack 1:1, the
net wallet effect over a session equals the sum of per-hand compressed results —
identical economics to the spec — while keeping the ledger trivial and the
invariant "wallet balance == sum(ledger)" exactly true. The compression is
surfaced in the UI as a toast ("−416 chips → −83 coins ×0.2") and a 練習モード
badge. Known simplification: within a bot-mixed hand, human-vs-human swings are
also compressed by that hand's factor; acceptable for Phase 1 and documented.

### Bots fill the practice table; humans displace them cleanly
The practice table is kept full of bots (always-on "賑わい", §9.4.1). A human who
joins takes an **idle** bot's seat immediately; if every bot is mid-hand, the
human is **queued and seated at the next hand boundary** (their buy-in is held),
so the running hand is never corrupted. Engine players are matched to seats by
id as well as index, so a reused seat can never show a departed bot's cards.
Bot reaction time is randomised 2–8s (§9.4.4) and bots are topped up each hand
(conceptually infinite bank, §9.4.4). Hiyoko uses backfill (§9.4.5);
usagi/dragon never seat bots (§9.4.1).

### Turn timers, disconnects, rate limits
Turn timeout is 20s (§3.2); on timeout the engine auto-checks or folds, and three
consecutive timeouts auto-sit-out (§3.2). A disconnected player auto-acts on
their turn and has a grace period to reconnect before being cashed out (§3.2).
Client messages are zod-validated (§10.2); actions and chat are rate-limited with
token buckets, and chat passes through an NG-word filter (§7.2, §10.3).

### Not built in Phase 1 (deferred, per spec)
Characters/shop (Phase 2), trading (Phase 3), ads (Phase 4), and real
auth/Supabase. Hard bot is Phase 3 (§9.4.2). No real-money features, ever,
until legal review (§12). Provable-fairness seed disclosure (§9.3) has a column
in the schema but is not yet wired.

---

## 2026-10-19 — Phase 1 foundation: poker-engine

### Scope of this change
The SPEC (§15) mandates building `packages/poker-engine` test-driven first,
then `game-server`, then `web`. This commit delivers the monorepo scaffold,
`packages/shared` (types/constants), and a complete, tested `packages/poker-engine`.
The game-server, poker-bot, and web app are explicitly **not** in this commit
and remain the next steps (see README "Status").

### Monorepo & tooling
- **pnpm workspaces** (not npm/yarn): the SPEC repo layout (§2) is a monorepo
  and pnpm workspaces are the lightest way to wire `workspace:*` deps.
- **Vitest** for tests (SPEC §2 names it) with the v8 coverage provider and a
  90%-line / 85%-branch threshold matching SPEC §13 ("engine coverage ≥ 90%").
- **TypeScript strict** plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` — the engine does a lot of array indexing and we
  want the compiler to catch off-by-one and undefined access.
- Packages expose their `src/index.ts` directly via the `exports` field (no
  build step needed for intra-repo consumption); a `build` script is still
  provided for when the server/web consume compiled output.

### Card representation
- Cards are `{ rank: 2..14, suit: 'c'|'d'|'h'|'s' }`. Numeric ranks (A = 14)
  make comparisons trivial. A string form (`"As"`, `"Td"`) exists purely for
  tests and debugging.

### Hand evaluator
- **Brute-force best-of-7**: we evaluate all C(7,5)=21 five-card combinations
  and take the max. A perfect-hash evaluator would be faster, but 21 combos is
  far below any performance concern (SPEC §13 targets 300 ms action latency,
  and evaluation is microseconds) and the brute-force version is obviously
  correct and trivial to audit — correctness beats cleverness for money logic.
- Hand strength is `{ category, tiebreakers[] }` compared lexicographically, so
  kickers and split pots fall out naturally with no special cases.
- The **wheel (A-2-3-4-5)** is handled explicitly and ranks as 5-high, both as a
  straight and a straight flush (SPEC §3.2).

### Betting / raise rules
- **Raise amounts are expressed as the total "raise-to"** street commitment, not
  the increment. This is the least ambiguous convention and matches most online
  clients; documented in the `Action` type.
- **Minimum raise** = current bet + size of the last full raise; minimum bet
  (no prior bet this street) = the big blind (SPEC §3.1).
- **Short all-in does not reopen betting** (SPEC §9.2): a full raise resets every
  other active player's `hasActed`; a sub-full all-in does not. A player whose
  `hasActed` is still true while facing a bet may therefore only call or fold.
  This single invariant encodes the whole re-open rule.
- **Betting is closed once ≤ 1 player can still wager.** A lone player with chips
  has no one to call, so they cannot bet or raise; any uncalled chips they
  already committed are returned to them as a solo side pot at showdown. This
  also prevents the "fold an uncalled bet and burn the chips" bug.

### Pots
- Side pots are built by peeling the smallest contribution level repeatedly
  (SPEC §3.2). The total of all pots always equals the sum of contributions —
  verified by a property test.
- **Odd chips on a split** go to the earliest position left of the button
  (SPEC §3.2 端数処理), implemented via a caller-supplied position order.
- **Uncalled bets** are not special-cased: an uncalled excess simply forms a
  side pot whose only eligible player is its contributor, who is then "awarded"
  it back. Chip conservation holds either way.

### Game state machine
- `startHand(opts) -> GameState` and `applyAction(state, action) -> GameState`
  are **pure** (no I/O, no clocks, no RNG except the injectable shuffler), per
  SPEC §9.1. The server will own timers, sockets and persistence.
- **Heads-up**: button = SB, acts first preflop; BB acts first postflop
  (SPEC §3.2). 3+ handed: SB left of button, BB next, UTG first to act.
- **No burn cards.** They have zero effect on a cryptographically shuffled deck
  and add state for no gameplay value. Can be added later for visual fidelity.
- **Turn timer, disconnect auto-fold, and 3-timeout auto-leave** (SPEC §3.2) are
  intentionally **not** in the engine — they are time-dependent and belong to
  the game-server, which will call `applyAction` with a fold/check on timeout.

### Short-BB blinds
- If a blind cannot cover its amount, the player posts their whole stack and is
  all-in; `currentBet` is still set to the nominal big blind (others must call
  the full BB). This is the common home-game convention and keeps the price of
  entry consistent. Revisit if we adopt a stricter casino rule later.

### Open questions deferred to later phases
- Exact bot decision thresholds (SPEC §9.4.7) — deferred to `packages/poker-bot`.
- Coin reflection (×0.2) accounting (SPEC §4.5) — deferred to the server/ledger
  layer; the engine only reports chip deltas per hand, which the server will
  compress and record to `coin_sink`.
- Server-restart handling of in-progress hands (SPEC §13) — Phase 1 plan is to
  refund stacks and abort; not yet implemented (no server yet).
