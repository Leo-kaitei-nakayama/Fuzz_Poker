/** A minimal profanity/NG-word filter for table chat (SPEC §7.2). */
const NG_WORDS = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "死ね",
  "殺す",
  "きもい",
  "うざい",
];

export function filterChat(text: string): string {
  let out = text;
  for (const w of NG_WORDS) {
    if (!w) continue;
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, "＊".repeat([...w].length));
  }
  return out.slice(0, 200);
}

/** A simple refillable token bucket for per-connection rate limiting. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private capacity: number,
    private refillPerSec: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  tryRemove(now = Date.now()): boolean {
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

const EMOJIS = ["🐱", "🐶", "🐰", "🐻", "🐥", "🦊", "🐼", "🐧", "🐸", "🐹"];

export function randomEmoji(rng: () => number = Math.random): string {
  return EMOJIS[Math.floor(rng() * EMOJIS.length)]!;
}
