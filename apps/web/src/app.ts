import type { ServerMessage, TableView, SeatView } from "@cute-poker/shared";

// ---- i18n (ja default + en) — minimal foundation, SPEC §7.3 --------------
type Lang = "ja" | "en";
const STR: Record<Lang, Record<string, string>> = {
  ja: {
    tagline: "かわいいキャラとゆるく遊ぶポーカー",
    play: "ゲストで遊ぶ",
    name: "ニックネーム",
    lobby: "ロビー",
    daily: "デイリーボーナス",
    coins: "コイン",
    join: "着席する",
    buyin: "バイイン",
    leave: "退席",
    fold: "フォールド",
    check: "チェック",
    call: "コール",
    raise: "レイズ",
    allin: "オールイン",
    bet: "ベット",
    waiting: "ほかのプレイヤーを待っています…",
    yourTurn: "あなたの番です",
    practiceMode: "🤖 練習モード (×0.2)",
    seats: "着席",
    send: "送信",
  },
  en: {
    tagline: "Relaxed poker with cute characters",
    play: "Play as guest",
    name: "Nickname",
    lobby: "Lobby",
    daily: "Daily bonus",
    coins: "coins",
    join: "Sit down",
    buyin: "Buy-in",
    leave: "Leave",
    fold: "Fold",
    check: "Check",
    call: "Call",
    raise: "Raise",
    allin: "All-in",
    bet: "Bet",
    waiting: "Waiting for players…",
    yourTurn: "Your turn",
    practiceMode: "🤖 Practice mode (×0.2)",
    seats: "seated",
    send: "Send",
  },
};
let lang: Lang = (localStorage.getItem("cp_lang") as Lang) || "ja";
const t = (k: string): string => STR[lang][k] ?? k;

// ---- app state -----------------------------------------------------------
interface LobbyTable {
  id: string;
  name: string;
  kind: string;
  sb: number;
  bb: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxSeats: number;
  occupied: number;
  botsPresent: boolean;
  phase: string;
}

let token = localStorage.getItem("cp_token") ?? "";
let displayName = localStorage.getItem("cp_name") ?? "";
let balance = 0;
let ws: WebSocket | null = null;
let table: TableView | null = null;
let raiseOpen = false;
const chatLog: { who: string; text: string }[] = [];

const app = document.getElementById("app")!;
const api = (path: string, opts: RequestInit = {}): Promise<Response> =>
  fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });

function toast(msg: string, kind = ""): void {
  const host = document.getElementById("toasts")!;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---- boot ----------------------------------------------------------------
async function boot(): Promise<void> {
  if (token) {
    const res = await api("/api/me");
    if (res.ok) {
      const data = (await res.json()) as { user: { displayName: string }; balance: number };
      displayName = data.user.displayName;
      balance = data.balance;
      void renderLobby();
      return;
    }
    token = "";
    localStorage.removeItem("cp_token");
  }
  renderLogin();
}

// ---- login ---------------------------------------------------------------
function renderLogin(): void {
  app.innerHTML = `
    <div class="login-hero">
      <div class="big">🐱🎴🐰</div>
      <h1>Cute Poker</h1>
      <p>${t("tagline")}</p>
    </div>
    <div class="card-panel">
      <label>${t("name")}</label>
      <input id="name" maxlength="20" placeholder="${t("name")}" value="${escapeHtml(displayName)}" />
      <div style="height:12px"></div>
      <button id="go" style="width:100%">${t("play")} →</button>
    </div>
    ${langToggle()}`;
  bindLangToggle();
  document.getElementById("go")!.addEventListener("click", async () => {
    const name = (document.getElementById("name") as HTMLInputElement).value.trim();
    const res = await api("/api/guest", {
      method: "POST",
      body: JSON.stringify({ displayName: name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    const data = (await res.json()) as { token: string; user: { displayName: string }; balance: number };
    token = data.token;
    displayName = data.user.displayName;
    balance = data.balance;
    localStorage.setItem("cp_token", token);
    localStorage.setItem("cp_name", displayName);
    void renderLobby();
  });
}

// ---- lobby ---------------------------------------------------------------
async function renderLobby(): Promise<void> {
  const res = await api("/api/lobby");
  const data = (await res.json()) as { tables: LobbyTable[] };
  app.innerHTML = `
    ${topbar(false)}
    <div class="card-panel">
      <div class="row" style="justify-content:space-between">
        <strong>${t("daily")}</strong>
        <button id="daily">🎁 ${t("daily")}</button>
      </div>
    </div>
    <div class="card-panel">
      <h3 style="margin-top:0">${t("lobby")}</h3>
      <div class="table-list">
        ${data.tables.map(tableCard).join("")}
      </div>
    </div>
    ${langToggle()}`;
  bindLangToggle();
  bindTopbar();
  document.getElementById("daily")!.addEventListener("click", claimDaily);
  for (const tb of data.tables) {
    document.getElementById(`join-${tb.id}`)?.addEventListener("click", () => openJoin(tb));
  }
}

function tableCard(tb: LobbyTable): string {
  const bots = tb.botsPresent ? `<span class="badge bot">🤖 Bot</span>` : "";
  const reflect = tb.botsPresent ? `<span class="badge reflect">×0.2</span>` : "";
  return `<div class="table-item">
    <div>
      <div><strong>${escapeHtml(tb.name)}</strong> ${bots} ${reflect}</div>
      <div class="meta">SB/BB ${tb.sb}/${tb.bb} · ${t("buyin")} ${tb.minBuyIn}–${tb.maxBuyIn} · ${tb.occupied}/${tb.maxSeats} ${t("seats")}</div>
    </div>
    <button id="join-${tb.id}">${t("join")}</button>
  </div>`;
}

async function claimDaily(): Promise<void> {
  const localDate = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD local
  const res = await api("/api/daily", { method: "POST", body: JSON.stringify({ localDate }) });
  const data = (await res.json()) as {
    alreadyClaimed: boolean;
    reward: number;
    streak: number;
    balance: number;
  };
  balance = data.balance;
  if (data.alreadyClaimed) toast(lang === "ja" ? "本日は受取済みです" : "Already claimed today");
  else toast(`🎁 +${data.reward} (${data.streak}日目 / day ${data.streak})`, "win");
  updateWallet();
}

function openJoin(tb: LobbyTable): void {
  const amount = Math.min(tb.maxBuyIn, Math.max(tb.minBuyIn, Math.min(balance, tb.minBuyIn)));
  app.innerHTML = `
    ${topbar(true)}
    <div class="card-panel">
      <h3 style="margin-top:0">${escapeHtml(tb.name)}</h3>
      <p class="meta">SB/BB ${tb.sb}/${tb.bb}</p>
      <label>${t("buyin")}: <strong id="bv">${amount}</strong></label>
      <input class="rng" type="range" id="amt" min="${tb.minBuyIn}" max="${Math.min(tb.maxBuyIn, balance)}" value="${amount}" step="${tb.sb}" />
      <div style="height:12px"></div>
      <button id="confirm" style="width:100%">${t("join")} →</button>
    </div>`;
  bindTopbar();
  const amt = document.getElementById("amt") as HTMLInputElement;
  amt.addEventListener("input", () => {
    document.getElementById("bv")!.textContent = amt.value;
  });
  document.getElementById("confirm")!.addEventListener("click", () => {
    joinTable(tb, Number(amt.value));
  });
}

// ---- table / websocket ---------------------------------------------------
function joinTable(tb: LobbyTable, buyIn: number): void {
  table = null;
  chatLog.length = 0;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
  ws.addEventListener("open", () => {
    send({ t: "joinTable", tableId: tb.id, buyIn });
  });
  ws.addEventListener("message", (ev) => onMessage(JSON.parse(ev.data) as ServerMessage));
  ws.addEventListener("close", () => {
    if (table) toast(lang === "ja" ? "接続が切れました" : "Disconnected");
  });
  renderTableShell(tb.name);
}

function send(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case "tableState":
      table = msg.table;
      renderTable();
      break;
    case "wallet":
      balance = msg.balance;
      updateWallet();
      break;
    case "chat":
      chatLog.push({ who: msg.displayName, text: msg.text });
      renderChatLog();
      break;
    case "handResult":
      showHandResult(msg);
      break;
    case "error":
      toast(msg.message);
      break;
    default:
      break;
  }
}

function showHandResult(msg: Extract<ServerMessage, { t: "handResult" }>): void {
  const me = table?.yourSeat;
  const mine = me !== null && me !== undefined ? msg.reflections.find((r) => r.userId === userIdOfSeat(me)) : undefined;
  if (mine && mine.rawDelta !== 0) {
    const sign = mine.walletDelta >= 0 ? "+" : "";
    if (mine.factor < 1) {
      toast(
        `${sign}${mine.rawDelta} ${lang === "ja" ? "チップ" : "chips"} → ${t("coins")} ${sign}${mine.walletDelta} (×${mine.factor})`,
        "reflect",
      );
    } else {
      toast(`${sign}${mine.walletDelta} ${t("coins")}`, mine.walletDelta >= 0 ? "win" : "");
    }
  }
  renderResultBanner(msg);
}

function userIdOfSeat(seat: number): string | undefined {
  return table?.seats.find((s) => s.seat === seat)?.userId;
}

// ---- rendering: table ----------------------------------------------------
function renderTableShell(name: string): void {
  app.innerHTML = `
    ${topbar(true)}
    <div class="card-panel" style="padding:12px 16px">
      <div class="row" style="justify-content:space-between">
        <strong id="tname">${escapeHtml(name)}</strong>
        <span id="tbadge"></span>
      </div>
    </div>
    <div id="felt-host"></div>
    <div id="action-host"></div>
    <div class="chat card-panel">
      <div class="chat-log" id="chatlog"></div>
      <div class="row" style="margin-top:8px">
        <input id="chatinput" placeholder="…" maxlength="200" style="flex:1" />
        <button id="chatsend" class="ghost">${t("send")}</button>
      </div>
    </div>`;
  bindTopbar();
  document.getElementById("chatsend")!.addEventListener("click", sendChat);
  document.getElementById("chatinput")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") sendChat();
  });
}

function sendChat(): void {
  const input = document.getElementById("chatinput") as HTMLInputElement | null;
  if (!input || !input.value.trim()) return;
  send({ t: "chat", text: input.value.trim() });
  input.value = "";
}

const SLOTS = [
  { top: 90, left: 50 },
  { top: 74, left: 13 },
  { top: 27, left: 10 },
  { top: 10, left: 50 },
  { top: 27, left: 90 },
  { top: 74, left: 87 },
];

function renderTable(): void {
  if (!table) return;
  if (!document.getElementById("felt-host")) renderTableShell(table.name);

  const badge = document.getElementById("tbadge");
  if (badge) badge.innerHTML = table.botsPresent ? `<span class="badge reflect">${t("practiceMode")}</span>` : "";

  const you = table.yourSeat ?? 0;
  const seatsHtml = table.seats
    .map((s) => {
      const slot = SLOTS[((s.seat - you + table!.maxSeats) % table!.maxSeats) % SLOTS.length]!;
      return seatHtml(s, slot);
    })
    .join("");

  const dealer =
    table.buttonSeat !== null
      ? (() => {
          const slot = SLOTS[((table!.buttonSeat! - you + table!.maxSeats) % table!.maxSeats) % SLOTS.length]!;
          // Place the button between the seat and the pot so it never overlaps
          // that seat's cards or chips.
          const bt = slot.top + (46 - slot.top) * 0.3;
          const bl = slot.left + (50 - slot.left) * 0.3;
          return `<div class="dealer-btn" style="top:${bt}%;left:${bl}%">D</div>`;
        })()
      : "";

  const felt = `
    <div class="felt">
      <div class="center">
        <div class="board">${table.board.map((c) => cardHtml(c)).join("") || ""}</div>
        <div class="pot">🪙 ${table.pot}</div>
      </div>
      ${seatsHtml}
      ${dealer}
    </div>`;
  document.getElementById("felt-host")!.innerHTML = felt;

  renderActionBar();
  renderChatLog();
}

function seatHtml(s: SeatView, slot: { top: number; left: number }): string {
  const cls = ["seat"];
  if (s.isTurn) cls.push("turn");
  if (s.folded) cls.push("folded");
  const holes = s.inHand
    ? s.holeCards
      ? s.holeCards.map((c) => cardHtml(c)).join("")
      : `<div class="pcard back"></div><div class="pcard back"></div>`
    : "";
  const botBadge = s.isBot ? `<span class="mini-badge">🤖 Bot</span>` : "";
  const bet = s.committedThisStreet > 0 ? `${s.committedThisStreet}` : "";
  return `<div class="${cls.join(" ")}" style="top:${slot.top}%;left:${slot.left}%">
    <div class="hole">${holes}</div>
    <div class="avatar">${s.avatarEmoji}</div>
    <div class="name">${escapeHtml(s.displayName)} ${botBadge}</div>
    <div class="stack">🪙 ${s.stack}</div>
    <div class="bet">${bet}</div>
  </div>`;
}

const SUIT: Record<string, string> = { s: "♠", c: "♣", h: "♥", d: "♦" };
const RANK: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };
function cardHtml(c: { rank: number; suit: string }): string {
  const r = RANK[c.rank] ?? String(c.rank === 10 ? "10" : c.rank);
  return `<div class="pcard ${c.suit}"><span>${r}</span><span class="suit">${SUIT[c.suit]}</span></div>`;
}

// ---- action bar ----------------------------------------------------------
function renderActionBar(): void {
  const host = document.getElementById("action-host");
  if (!host || !table) return;
  const legal = table.yourLegal;
  const myTurn = table.yourSeat !== null && table.toActSeat === table.yourSeat && legal;

  if (!myTurn) {
    const note =
      table.phase === "WAITING"
        ? t("waiting")
        : table.yourSeat === null
          ? lang === "ja"
            ? "観戦中"
            : "Spectating"
          : lang === "ja"
            ? "ほかのプレイヤーの番です"
            : "Waiting for others";
    host.innerHTML = `<div class="actionbar"><div class="waiting-note">${note}</div>
      <button class="ghost" id="leave2" style="width:100%;margin-top:6px">${t("leave")}</button></div>`;
    document.getElementById("leave2")?.addEventListener("click", leaveTable);
    return;
  }

  const l = legal!;
  const canCheck = l.types.includes("check");
  const callLabel = canCheck ? t("check") : `${t("call")} ${l.callAmount}`;
  const canRaise = l.types.includes("raise") && l.minRaiseTo !== null;
  const canAllin = l.types.includes("allin");

  host.innerHTML = `
    <div class="actionbar">
      <div class="waiting-note" style="color:var(--accent-dark);font-weight:800">${t("yourTurn")}</div>
      <div class="btns">
        <button class="fold" id="a-fold">${t("fold")}</button>
        <button class="call" id="a-call">${callLabel}</button>
        <button class="raise" id="a-raise" ${canRaise || canAllin ? "" : "disabled"}>${table.currentBet === 0 ? t("bet") : t("raise")}</button>
      </div>
      <div class="raise-controls" id="raisec" style="display:${raiseOpen && canRaise ? "block" : "none"}">
        <label>${t("raise")}: <strong id="rv">${l.minRaiseTo}</strong></label>
        <input class="rng" type="range" id="rraise" min="${l.minRaiseTo}" max="${l.maxRaiseTo}" value="${l.minRaiseTo}" step="${table.bb}" />
        <div class="presets">
          <button data-f="0.5">½ ${lang === "ja" ? "ポット" : "pot"}</button>
          <button data-f="0.75">¾</button>
          <button data-f="1">${lang === "ja" ? "ポット" : "pot"}</button>
          <button data-f="max">${t("allin")}</button>
          <button id="r-confirm" style="color:white;background:var(--accent)">OK</button>
        </div>
      </div>
    </div>`;

  document.getElementById("a-fold")!.addEventListener("click", () => act("fold"));
  document.getElementById("a-call")!.addEventListener("click", () => act(canCheck ? "check" : "call"));
  document.getElementById("a-raise")!.addEventListener("click", () => {
    if (canRaise) {
      raiseOpen = !raiseOpen;
      renderActionBar();
    } else if (canAllin) {
      act("allin");
    }
  });

  if (raiseOpen && canRaise) {
    const rng = document.getElementById("rraise") as HTMLInputElement;
    const rv = document.getElementById("rv")!;
    rng.addEventListener("input", () => (rv.textContent = rng.value));
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".presets button[data-f]"))) {
      btn.addEventListener("click", () => {
        const f = btn.dataset.f!;
        let to: number;
        if (f === "max") to = l.maxRaiseTo!;
        else to = Math.min(l.maxRaiseTo!, Math.max(l.minRaiseTo!, table!.currentBet + Math.round(table!.pot * Number(f))));
        rng.value = String(to);
        rv.textContent = String(to);
      });
    }
    document.getElementById("r-confirm")!.addEventListener("click", () => {
      act("raise", Number(rng.value));
      raiseOpen = false;
    });
  }
}

function act(action: string, amount?: number): void {
  send(amount === undefined ? { t: "action", action } : { t: "action", action, amount });
}

function leaveTable(): void {
  send({ t: "leaveTable" });
  ws?.close();
  ws = null;
  table = null;
  void renderLobby();
}

// ---- misc rendering ------------------------------------------------------
function renderChatLog(): void {
  const el = document.getElementById("chatlog");
  if (!el) return;
  el.innerHTML = chatLog
    .slice(-30)
    .map((l) => `<div class="line"><span class="who">${escapeHtml(l.who)}:</span> ${escapeHtml(l.text)}</div>`)
    .join("");
  el.scrollTop = el.scrollHeight;
}

function renderResultBanner(msg: Extract<ServerMessage, { t: "handResult" }>): void {
  const host = document.getElementById("felt-host");
  if (!host) return;
  const names = msg.pots
    .flatMap((p) => p.winners)
    .map((id) => table?.seats.find((s) => s.userId === id)?.displayName ?? "?");
  const banner = document.createElement("div");
  banner.className = "result-banner";
  const total = msg.pots.reduce((s, p) => s + p.amount, 0);
  banner.innerHTML = `🏆 ${escapeHtml([...new Set(names)].join(", "))} +${total}
    ${msg.reflectionFactor < 1 ? `<div class="raw">${t("practiceMode")}</div>` : ""}`;
  host.appendChild(banner);
  setTimeout(() => banner.remove(), 3000);
}

function topbar(back: boolean): string {
  return `<div class="topbar">
    <div class="brand">${back ? `<span id="back" style="cursor:pointer">←</span> ` : ""}🎴 Cute Poker</div>
    <div class="wallet"><span class="coin">🪙</span> <span id="wal">${balance}</span></div>
  </div>`;
}
function bindTopbar(): void {
  document.getElementById("back")?.addEventListener("click", () => {
    if (ws) leaveTable();
    else void renderLobby();
  });
}
function updateWallet(): void {
  const el = document.getElementById("wal");
  if (el) el.textContent = String(balance);
}

function langToggle(): string {
  return `<div style="text-align:center;margin-top:8px">
    <button class="ghost" id="lang" style="padding:6px 14px;font-size:13px">${lang === "ja" ? "English" : "日本語"}</button>
  </div>`;
}
function bindLangToggle(): void {
  document.getElementById("lang")?.addEventListener("click", () => {
    lang = lang === "ja" ? "en" : "ja";
    localStorage.setItem("cp_lang", lang);
    if (ws) renderTable();
    else if (token) void renderLobby();
    else renderLogin();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

void boot();
