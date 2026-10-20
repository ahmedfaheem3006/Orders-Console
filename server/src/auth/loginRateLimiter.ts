// Limits login attempts per (client IP + email): after MAX_ATTEMPTS unsuccessful
// attempts inside WINDOW_MS, that pair gets 429 until the window ends, even with the
// right password, so guessing cannot simply continue. A success clears the count.
//
// Attempts are counted BEFORE the (slow, async) password check, not after a failure:
// otherwise many parallel guesses would all pass the check before any failure was
// recorded.
//
// Deliberately simple: in memory, per process, cleared on restart. It slows down
// password guessing against one account; it does not stop a distributed attack
// across many IPs. req.ip is the socket address (Express "trust proxy" is off).
export const MAX_ATTEMPTS = 5;
export const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10_000; // bounds memory if someone sprays many emails

interface Entry {
  attempts: number;
  windowStart: number;
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(ip: string, email: string): string {
    return `${ip}|${email.toLowerCase()}`;
  }

  private current(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.windowStart >= WINDOW_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  // Seconds until the pair may try again, or 0 if it is not blocked.
  retryAfterSeconds(ip: string, email: string): number {
    const entry = this.current(this.key(ip, email));
    if (!entry || entry.attempts < MAX_ATTEMPTS) return 0;
    return Math.ceil((entry.windowStart + WINDOW_MS - this.now()) / 1000);
  }

  recordAttempt(ip: string, email: string): void {
    const key = this.key(ip, email);
    const entry = this.current(key);
    if (entry) {
      entry.attempts++;
      return;
    }
    if (this.entries.size >= MAX_TRACKED) {
      // Map keeps insertion order: drop the oldest window.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { attempts: 1, windowStart: this.now() });
  }

  recordSuccess(ip: string, email: string): void {
    this.entries.delete(this.key(ip, email));
  }
}
