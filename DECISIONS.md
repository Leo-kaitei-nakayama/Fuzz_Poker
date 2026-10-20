# DECISIONS.md

Per SPEC §0.4, every point where the spec left a choice open is recorded here
with the option taken and the reasoning. Dated entries, newest first.

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
