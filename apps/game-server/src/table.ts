import { randomUUID } from "node:crypto";
import {
  cardToString,
  type Action,
  type ActionType,
  type Card,
  type GameState,
  type HandReflectionView,
  type PotResultView,
  type SeatView,
  type ServerMessage,
  type ShowdownView,
  type TableView,
} from "@cute-poker/shared";
import {
  applyAction,
  evaluateBest,
  HAND_CATEGORY_NAME,
  legalActions,
  startHand,
  type SeatConfig,
} from "@cute-poker/poker-engine";
import { decideAction, type Difficulty } from "@cute-poker/poker-bot";
import { factorForHand, reflect } from "./economy.js";
import type { CoinSinkRecord, HandHistoryRecord, Store } from "./store/types.js";

export interface TableDef {
  id: string;
  name: string;
  kind: string;
  sb: number;
  bb: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxSeats: number;
  /** 'always' = keep full of bots; 'backfill' = add bots only to continue; 'none'. */
  botFill: "always" | "backfill" | "none";
}

export interface TableHooks {
  now(): number;
  /** Schedule fn after ms; returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
  rng(): number;
  /** Ask the server to push a fresh per-viewer tableState to everyone here. */
  emitState(): void;
  /** Broadcast a discrete event to everyone at the table. */
  emitEvent(msg: ServerMessage): void;
  /** Random reaction delay for a bot action (ms). */
  botDelayMs(): number;
  /** Delay before the next hand starts (ms). */
  interHandMs(): number;
  turnTimeoutMs(): number;
}

interface Seat {
  seat: number;
  userId: string;
  displayName: string;
  avatarEmoji: string;
  isBot: boolean;
  botDifficulty: Difficulty;
  stack: number;
  sittingOut: boolean;
  connected: boolean;
  inHand: boolean;
  stackAtHandStart: number;
  consecutiveTimeouts: number;
  holeCards: Card[];
}

interface SeatOccupant {
  userId: string;
  displayName: string;
  avatarEmoji: string;
  isBot: boolean;
  botDifficulty?: Difficulty;
}

const DEFAULT_BOT_STACK_MULT = 1; // bots are topped up to maxBuyIn each hand

export class Table {
  readonly def: TableDef;
  private store: Store;
  private hooks: TableHooks;

  private seats: (Seat | null)[];
  private state: GameState | null = null;
  private handNumber = 0;
  private buttonSeat = -1;
  private actionDeadline: number | null = null;
  private cancelTurnTimer: (() => void) | null = null;
  private pendingStart: (() => void) | null = null;
  /** Humans waiting for a seat to free up at the next hand boundary. */
  private pendingSeats: { occupant: SeatOccupant; stack: number }[] = [];

  /** Actions taken during the current hand, for hand_history. */
  private actionLog: { seat: number; action: ActionType; amount: number }[] = [];
  private handStartedAt = 0;
  private handBotPresent = false;
  private handId = "";

  constructor(def: TableDef, store: Store, hooks: TableHooks) {
    this.def = def;
    this.store = store;
    this.hooks = hooks;
    this.seats = Array.from({ length: def.maxSeats }, () => null);
  }

  // ---- seating -----------------------------------------------------------

  isInHand(): boolean {
    return this.state !== null && this.state.phase !== "HAND_END";
  }

  occupiedSeats(): number {
    return this.seats.filter((s) => s !== null).length;
  }

  humanSeats(): Seat[] {
    return this.seats.filter((s): s is Seat => s !== null && !s.isBot);
  }

  findSeatByUser(userId: string): Seat | null {
    return this.seats.find((s): s is Seat => s !== null && s.userId === userId) ?? null;
  }

  /**
   * Seat a human (or bot). Returns the seat index, or -1 if the human was
   * queued because every seat is a bot currently in a hand (they will be seated
   * at the next hand boundary, evicting a bot — SPEC §9.4.1).
   */
  seatPlayer(occupant: SeatOccupant, stack: number, preferredSeat?: number): number {
    if (this.findSeatByUser(occupant.userId) || this.pendingSeats.some((p) => p.occupant.userId === occupant.userId)) {
      throw new TableError("already_seated", "You are already seated at this table");
    }

    let idx = this.pickFreeSeat(preferredSeat);

    // A human may displace an idle (between-hands) bot immediately.
    if (idx < 0 && !occupant.isBot && this.def.botFill !== "none") {
      const idle = this.seats.find((s): s is Seat => s?.isBot === true && !s.inHand);
      if (idle) {
        this.nullSeat(idle.seat);
        idx = idle.seat;
      }
    }

    if (idx < 0) {
      if (occupant.isBot) throw new TableError("table_full", "No open seats");
      // Queue: seated at the next hand boundary (their buy-in is already held).
      this.pendingSeats.push({ occupant, stack });
      this.hooks.emitState();
      return -1;
    }

    this.placeSeat(idx, occupant, stack);
    this.hooks.emitState();
    this.maybeStartHand();
    return idx;
  }

  private pickFreeSeat(preferredSeat?: number): number {
    if (preferredSeat !== undefined && this.seats[preferredSeat] === null) return preferredSeat;
    return this.seats.findIndex((s) => s === null);
  }

  private placeSeat(idx: number, occupant: SeatOccupant, stack: number): void {
    this.seats[idx] = {
      seat: idx,
      userId: occupant.userId,
      displayName: occupant.displayName,
      avatarEmoji: occupant.avatarEmoji,
      isBot: occupant.isBot,
      botDifficulty: occupant.botDifficulty ?? "normal",
      stack,
      sittingOut: false,
      connected: true,
      inHand: false,
      stackAtHandStart: stack,
      consecutiveTimeouts: 0,
      holeCards: [],
    };
    this.hooks.emitEvent({
      t: "playerJoined",
      seat: idx,
      displayName: occupant.displayName,
      isBot: occupant.isBot,
    });
  }

  private nullSeat(idx: number): void {
    this.seats[idx] = null;
    this.hooks.emitEvent({ t: "playerLeft", seat: idx });
  }

  /** Seat any queued humans, evicting idle bots to make room (between hands). */
  private seatPendingHumans(): void {
    while (this.pendingSeats.length > 0) {
      let idx = this.pickFreeSeat();
      if (idx < 0) {
        const bot = this.seats.find((s): s is Seat => s?.isBot === true);
        if (!bot) break; // table genuinely full of humans
        this.nullSeat(bot.seat);
        idx = bot.seat;
      }
      const p = this.pendingSeats.shift()!;
      this.placeSeat(idx, p.occupant, p.stack);
    }
  }

  /** Remove a player. Returns their remaining stack to cash out (0 for bots). */
  removePlayer(userId: string): number {
    // Queued but not yet seated: refund the held buy-in.
    const queuedIdx = this.pendingSeats.findIndex((p) => p.occupant.userId === userId);
    if (queuedIdx >= 0) {
      const [p] = this.pendingSeats.splice(queuedIdx, 1);
      this.hooks.emitState();
      return p!.stack;
    }

    const seat = this.findSeatByUser(userId);
    if (!seat) return 0;
    const remaining = seat.isBot ? 0 : seat.stack;

    // If they are in the current hand, fold them so the hand continues cleanly.
    if (this.isInHand() && seat.inHand && !this.folded(seat.seat)) {
      const wasTheirTurn = this.state!.toActSeat === seat.seat;
      this.seats[seat.seat] = null;
      this.hooks.emitEvent({ t: "playerLeft", seat: seat.seat });
      if (wasTheirTurn) {
        this.applyEngineAction(seat.seat, { type: foldOrCheckType(this.state!, seat.seat) });
        this.afterAction();
      }
      // If it wasn't their turn, the engine player stays (will be auto-folded
      // when action reaches it via the orphan check in scheduleActorTimer).
      this.hooks.emitState();
      return remaining;
    }

    this.seats[seat.seat] = null;
    this.hooks.emitEvent({ t: "playerLeft", seat: seat.seat });
    this.hooks.emitState();
    if (!this.isInHand()) this.maybeStartHand();
    return remaining;
  }

  setConnected(userId: string, connected: boolean): void {
    const seat = this.findSeatByUser(userId);
    if (!seat) return;
    seat.connected = connected;
    // If it's their turn and they just dropped, auto-act so play continues.
    if (!connected && this.isInHand() && this.state!.toActSeat === seat.seat) {
      this.autoAct(seat.seat);
    }
    this.hooks.emitState();
  }

  sitOut(userId: string, out: boolean): void {
    const seat = this.findSeatByUser(userId);
    if (!seat) return;
    seat.sittingOut = out;
    if (!out) seat.consecutiveTimeouts = 0;
    this.hooks.emitState();
    if (!this.isInHand()) this.maybeStartHand();
  }

  rebuy(userId: string, amount: number): void {
    const seat = this.findSeatByUser(userId);
    if (!seat || seat.isBot) return;
    seat.stack += amount;
    this.hooks.emitState();
    if (!this.isInHand()) this.maybeStartHand();
  }

  // ---- player actions ----------------------------------------------------

  handleAction(userId: string, action: { action: ActionType; amount?: number | undefined }): void {
    if (!this.isInHand()) throw new TableError("no_hand", "No hand in progress");
    const seat = this.findSeatByUser(userId);
    if (!seat) throw new TableError("not_seated", "You are not seated here");
    if (this.state!.toActSeat !== seat.seat) {
      throw new TableError("not_your_turn", "It is not your turn");
    }
    this.applyEngineAction(seat.seat, { type: action.action, amount: action.amount });
    this.afterAction();
  }

  // ---- hand lifecycle ----------------------------------------------------

  private eligibleSeats(): Seat[] {
    return this.seats.filter(
      (s): s is Seat => s !== null && !s.sittingOut && s.stack > 0,
    );
  }

  /** Fill empty seats with bots according to the table's policy (SPEC §9.4). */
  private applyBotFill(): void {
    if (this.def.botFill === "none") return;

    const humans = this.humanSeats().filter((s) => !s.sittingOut && s.stack > 0);
    const empties = this.seats
      .map((s, i) => (s === null ? i : -1))
      .filter((i) => i >= 0);

    if (this.def.botFill === "backfill") {
      // Only add bots when at least one human is present and fewer than two
      // humans are ready — just enough to keep a game going (SPEC §9.4.5).
      if (humans.length < 1) return;
      if (humans.length >= 2) return;
      if (empties.length === 0) return;
      this.addBot(empties[0]!);
      return;
    }

    // 'always' (practice table): keep all seats filled with bots.
    for (const i of empties) this.addBot(i);
  }

  private addBot(seatIndex: number): void {
    const n = this.botCount() + 1;
    const names = ["ミケ", "シロ", "クロ", "タマ", "モモ", "ハナ"];
    const emojis = ["🐱", "🐶", "🐰", "🐻", "🐥", "🦊"];
    const difficulty: Difficulty = this.hooks.rng() < 0.5 ? "easy" : "normal";
    const id = `bot:${this.def.id}:${seatIndex}:${randomUUID().slice(0, 8)}`;
    this.seats[seatIndex] = {
      seat: seatIndex,
      userId: id,
      displayName: `Bot-${names[seatIndex % names.length]}`,
      avatarEmoji: emojis[seatIndex % emojis.length]!,
      isBot: true,
      botDifficulty: difficulty,
      stack: this.def.maxBuyIn * DEFAULT_BOT_STACK_MULT,
      sittingOut: false,
      connected: true,
      inHand: false,
      stackAtHandStart: this.def.maxBuyIn,
      consecutiveTimeouts: 0,
      holeCards: [],
    };
    void n;
  }

  private botCount(): number {
    return this.seats.filter((s) => s?.isBot).length;
  }

  /** Remove idle bots so humans can take their seats (practice/backfill). */
  private pruneBots(): void {
    if (this.def.botFill === "none") return;
    if (this.def.botFill === "backfill") {
      // If two or more humans are ready, drop bots at hand boundaries.
      const humans = this.humanSeats().filter((s) => !s.sittingOut && s.stack > 0);
      if (humans.length >= 2) {
        for (let i = 0; i < this.seats.length; i++) {
          if (this.seats[i]?.isBot) this.seats[i] = null;
        }
      }
    }
  }

  maybeStartHand(): void {
    if (this.isInHand()) return;
    if (this.pendingStart) return;

    this.seatPendingHumans();
    this.pruneBots();
    this.applyBotFill();

    const eligible = this.eligibleSeats();
    if (eligible.length < 2) {
      this.state = null;
      this.actionDeadline = null;
      this.hooks.emitState();
      return;
    }
    this.startNewHand(eligible);
  }

  private startNewHand(eligible: Seat[]): void {
    // Top up bots so they always have chips to play (SPEC §9.4.4).
    for (const s of this.seats) {
      if (s?.isBot && s.stack < this.def.maxBuyIn) s.stack = this.def.maxBuyIn;
    }

    // Rotate the button to the next eligible seat clockwise.
    const eligibleSorted = [...eligible].sort((a, b) => a.seat - b.seat);
    this.buttonSeat = this.nextButton(eligibleSorted);

    const configs: SeatConfig[] = eligibleSorted.map((s) => ({
      id: s.userId,
      seat: s.seat,
      stack: s.stack,
    }));

    this.handNumber += 1;
    this.handId = randomUUID();
    this.handStartedAt = this.hooks.now();
    this.actionLog = [];

    // Reset per-hand seat markers.
    for (const s of this.seats) {
      if (!s) continue;
      const playing = eligibleSorted.some((e) => e.seat === s.seat);
      s.inHand = playing;
      s.stackAtHandStart = s.stack;
      s.holeCards = [];
    }

    this.state = startHand({
      players: configs,
      buttonSeat: this.buttonSeat,
      sb: this.def.sb,
      bb: this.def.bb,
      handNumber: this.handNumber,
      randInt: (n) => Math.floor(this.hooks.rng() * n),
    });

    // Cache hole cards per seat for views / showdown.
    for (const p of this.state.players) {
      const seat = this.seats[p.seat];
      if (seat) seat.holeCards = [...p.holeCards];
    }

    this.handBotPresent = this.state.players.some((p) => {
      const seat = this.seats[p.seat];
      return seat?.isBot === true;
    });

    this.hooks.emitEvent({
      t: "handStarted",
      handNumber: this.handNumber,
      botsPresent: this.handBotPresent,
      reflectionFactor: factorForHand(this.handBotPresent),
    });
    this.afterAction();
  }

  private nextButton(eligibleSorted: Seat[]): number {
    if (this.buttonSeat < 0) return eligibleSorted[0]!.seat;
    const after = eligibleSorted.find((s) => s.seat > this.buttonSeat);
    return (after ?? eligibleSorted[0]!).seat;
  }

  /** After any engine mutation: settle if over, else drive the next actor. */
  private afterAction(): void {
    if (!this.state) return;
    this.syncStacksFromEngine();

    if (this.state.phase === "HAND_END") {
      this.settleHand();
      return;
    }

    const toAct = this.state.toActSeat;
    if (toAct === null) return;
    this.actionDeadline = this.hooks.now() + this.hooks.turnTimeoutMs();
    this.hooks.emitEvent({ t: "actionRequired", seat: toAct, deadline: this.actionDeadline });
    this.hooks.emitState();
    this.scheduleActorTimer(toAct);
  }

  private scheduleActorTimer(seat: number): void {
    this.cancelTurnTimer?.();
    const s = this.seats[seat];
    if (!s) {
      // Orphaned engine seat — the occupant left mid-hand. Fold it out so the
      // hand keeps moving.
      this.cancelTurnTimer = this.hooks.setTimer(0, () => {
        if (this.state?.toActSeat === seat) this.autoAct(seat);
      });
      return;
    }

    if (s.isBot) {
      this.cancelTurnTimer = this.hooks.setTimer(this.hooks.botDelayMs(), () => {
        if (this.state?.toActSeat !== seat) return;
        const action = decideAction({
          state: this.state,
          seat,
          difficulty: s.botDifficulty,
          rng: this.hooks.rng,
        });
        this.applyEngineAction(seat, action);
        this.afterAction();
      });
      return;
    }

    if (!s.connected || s.sittingOut) {
      // Disconnected / sitting out: act immediately so play is not stalled.
      this.cancelTurnTimer = this.hooks.setTimer(0, () => {
        if (this.state?.toActSeat === seat) this.autoAct(seat);
      });
      return;
    }

    this.cancelTurnTimer = this.hooks.setTimer(this.hooks.turnTimeoutMs(), () => {
      if (this.state?.toActSeat !== seat) return;
      s.consecutiveTimeouts += 1;
      this.autoAct(seat);
      // Three consecutive timeouts -> auto sit-out (SPEC §3.2).
      if (s.consecutiveTimeouts >= 3) s.sittingOut = true;
    });
  }

  private autoAct(seat: number): void {
    if (!this.state) return;
    this.applyEngineAction(seat, { type: foldOrCheckType(this.state, seat) });
    this.afterAction();
  }

  private applyEngineAction(
    seat: number,
    action: { type: ActionType; amount?: number | undefined },
  ): void {
    if (!this.state) return;
    this.cancelTurnTimer?.();
    this.cancelTurnTimer = null;
    const prevPhase = this.state.phase;
    const engineAction: Action =
      action.amount === undefined ? { type: action.type } : { type: action.type, amount: action.amount };
    this.state = applyAction(this.state, engineAction);

    // Reset the acting human's timeout counter on a voluntary action.
    const s = this.seats[seat];
    if (s && !s.isBot) s.consecutiveTimeouts = 0;

    const applied = this.state.players.find((p) => p.seat === seat);
    this.actionLog.push({
      seat,
      action: action.type,
      amount: applied?.streetCommitted ?? action.amount ?? 0,
    });
    this.hooks.emitEvent({
      t: "actionApplied",
      seat,
      action: action.type,
      amount: action.amount ?? 0,
    });
    if (this.state.phase !== prevPhase && this.state.phase !== "HAND_END") {
      this.hooks.emitEvent({ t: "phaseChanged", phase: this.state.phase, board: [...this.state.board] });
    }
  }

  private syncStacksFromEngine(): void {
    if (!this.state) return;
    for (const p of this.state.players) {
      const seat = this.seats[p.seat];
      if (seat) seat.stack = p.stack;
    }
  }

  // ---- settlement + reflection (SPEC §4.5) -------------------------------

  private settleHand(): void {
    const state = this.state!;
    const factor = factorForHand(this.handBotPresent);
    const reflections: HandReflectionView[] = [];

    // Apply x-factor compression to each HUMAN's raw chip result this hand.
    for (const s of this.seats) {
      if (!s || !s.inHand) continue;
      const enginePlayer = state.players.find((p) => p.seat === s.seat && p.id === s.userId);
      if (!enginePlayer) continue;
      const rawDelta = enginePlayer.stack - s.stackAtHandStart;

      if (s.isBot) {
        s.stack = enginePlayer.stack; // bots are topped up next hand
        continue;
      }

      const r = reflect(rawDelta, factor);
      s.stack = s.stackAtHandStart + r.reflectedDelta;

      if (factor < 1 && rawDelta !== 0) {
        const sink: CoinSinkRecord = {
          handId: this.handId,
          userId: s.userId,
          rawAmount: rawDelta,
          factor,
          destroyedAmount: r.destroyed,
        };
        this.store.recordCoinSink(sink);
      }

      reflections.push({
        userId: s.userId,
        displayName: s.displayName,
        rawDelta,
        factor,
        walletDelta: r.reflectedDelta,
      });
    }

    const pots: PotResultView[] = state.results.map((pr) => ({
      amount: pr.amount,
      winners: [...pr.winners],
      payouts: { ...pr.payouts },
    }));

    // Reveal hole cards only if the hand reached a real showdown (>1 contender
    // saw cards). An uncontested pot never exposes cards (SPEC §3.2).
    const contenders = state.players.filter((p) => p.inHand && !p.folded);
    if (contenders.length > 1 && state.board.length === 5) {
      const reveals: ShowdownView["reveals"] = contenders.map((p) => {
        const hv = evaluateBest([...p.holeCards, ...state.board]);
        return {
          seat: p.seat,
          userId: p.id,
          holeCards: [...p.holeCards],
          handName: HAND_CATEGORY_NAME[hv.category],
        };
      });
      this.hooks.emitEvent({
        t: "showdown",
        showdown: { board: [...state.board], reveals, pots },
      });
    }

    this.hooks.emitEvent({
      t: "handResult",
      pots,
      reflections,
      reflectionFactor: factor,
      botsPresent: this.handBotPresent,
    });

    this.recordHandHistory(state, pots);

    this.actionDeadline = null;
    this.hooks.emitState();

    // Schedule the next hand.
    this.pendingStart = this.hooks.setTimer(this.hooks.interHandMs(), () => {
      this.pendingStart = null;
      this.maybeStartHand();
    });
  }

  private recordHandHistory(state: GameState, pots: PotResultView[]): void {
    const record: HandHistoryRecord = {
      id: this.handId,
      tableId: this.def.id,
      handNumber: this.handNumber,
      startedAt: this.handStartedAt,
      players: state.players.map((p) => {
        const seat = this.seats[p.seat];
        return {
          seat: p.seat,
          userId: p.id,
          displayName: seat?.displayName ?? p.id,
          isBot: seat?.isBot ?? false,
          holeCards: p.holeCards.map(cardToString),
          startStack: seat?.stackAtHandStart ?? 0,
          folded: p.folded,
        };
      }),
      actions: this.actionLog,
      board: state.board.map(cardToString),
      potResults: pots,
      botsPresent: this.handBotPresent,
      reflectionFactor: factorForHand(this.handBotPresent),
    };
    try {
      this.store.recordHand(record);
    } catch {
      // Hand history is best-effort; never break gameplay on a logging error.
    }
  }

  private folded(seat: number): boolean {
    return this.state?.players.find((p) => p.seat === seat)?.folded ?? false;
  }

  // ---- views -------------------------------------------------------------

  snapshotFor(userId: string | null): TableView {
    const state = this.state;
    const yourSeat = userId ? (this.findSeatByUser(userId)?.seat ?? null) : null;
    const showdownAll =
      state?.phase === "HAND_END" &&
      state.players.filter((p) => p.inHand && !p.folded).length > 1 &&
      state.board.length === 5;

    const seatViews: SeatView[] = [];
    for (const s of this.seats) {
      if (!s) continue;
      const enginePlayer = state?.players.find((p) => p.seat === s.seat && p.id === s.userId);
      const reveal = Boolean(
        yourSeat === s.seat || (showdownAll && enginePlayer && !enginePlayer.folded),
      );
      seatViews.push({
        seat: s.seat,
        userId: s.userId,
        displayName: s.displayName,
        avatarEmoji: s.avatarEmoji,
        isBot: s.isBot,
        stack: s.stack,
        committedThisStreet: enginePlayer?.streetCommitted ?? 0,
        folded: enginePlayer?.folded ?? false,
        allIn: enginePlayer?.allIn ?? false,
        sittingOut: s.sittingOut,
        inHand: enginePlayer?.inHand ?? false,
        holeCards: reveal && s.holeCards.length ? [...s.holeCards] : null,
        isTurn: state?.toActSeat === s.seat,
      });
    }

    const pot = state ? state.players.reduce((sum, p) => sum + p.committed, 0) : 0;

    let yourLegal: TableView["yourLegal"] = null;
    if (state && yourSeat !== null && state.toActSeat === yourSeat) {
      const la = legalActions(state);
      if (la) {
        yourLegal = {
          types: la.types,
          callAmount: la.callAmount,
          minRaiseTo: la.raise?.min ?? null,
          maxRaiseTo: la.raise?.max ?? null,
        };
      }
    }

    return {
      tableId: this.def.id,
      name: this.def.name,
      kind: this.def.kind,
      sb: this.def.sb,
      bb: this.def.bb,
      minBuyIn: this.def.minBuyIn,
      maxBuyIn: this.def.maxBuyIn,
      maxSeats: this.def.maxSeats,
      botsPresent: this.seats.some((s) => s?.isBot),
      reflectionFactor: factorForHand(this.seats.some((s) => s?.isBot)),
      phase: state?.phase ?? "WAITING",
      handNumber: this.handNumber,
      buttonSeat: this.buttonSeat >= 0 ? this.buttonSeat : null,
      board: state ? [...state.board] : [],
      pot,
      currentBet: state?.currentBet ?? 0,
      toActSeat: state?.toActSeat ?? null,
      actionDeadline: this.actionDeadline,
      seats: seatViews,
      yourSeat,
      yourLegal,
    };
  }
}

function foldOrCheckType(state: GameState, seat: number): ActionType {
  const la = legalActions(state);
  if (la && la.seat === seat && la.types.includes("check")) return "check";
  return "fold";
}

export class TableError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "TableError";
  }
}
