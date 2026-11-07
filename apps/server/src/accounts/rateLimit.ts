import { isLocalAddress } from '../net.ts';

/** Addresses remembered at most: past it (guessing spread over very many), those whose last failure is oldest go first. */
const MAX_ADDRESSES = 10_000;
/** How often addresses with nothing recent are forgotten, at most. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Failed tries per client address within a sliding window (or every try, with `take`): past `max`, an
 * address is refused until its oldest one is `windowMs` old. Only addresses count, never usernames, so
 * someone guessing at a username can't lock its owner out. Beside that, a budget for every address outside
 * the home network together (`outsideMax`), so guessing spread over many addresses is refused too; the home
 * network keeps only its own budgets, so someone outside can't lock the household out. Addresses with nothing
 * recent are forgotten as it goes. In memory: a restart forgives, which is fine at home.
 */
export class RateLimiter {
  private readonly failures = new Map<string, number[]>();
  /** Failures from outside the home network, every address together. */
  private outside: number[] = [];
  private sweptAt: number;

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly outsideMax = 100,
  ) {
    this.sweptAt = now();
  }

  /** True while the address has tries left, and, outside the home network, while everyone outside has. */
  allows(address: string): boolean {
    if (this.recent(address).length >= this.max) return false;
    return isLocalAddress(address) || this.recentOutside().length < this.outsideMax;
  }

  fail(address: string) {
    const list = [...this.recent(address), this.now()];
    // Last in the map: past MAX_ADDRESSES, those that failed longest ago go first.
    this.failures.delete(address);
    this.failures.set(address, list);
    if (!isLocalAddress(address)) this.outside = [...this.recentOutside(), this.now()];
    this.sweep();
  }

  /** For a limit on every try, not only the failed ones: false when the address has none left, else counts this one. */
  take(address: string): boolean {
    if (!this.allows(address)) return false;
    this.fail(address);
    return true;
  }

  /** How many addresses it remembers (for tests). */
  get size(): number {
    return this.failures.size;
  }

  private recent(address: string): number[] {
    const from = this.now() - this.windowMs;
    const list = (this.failures.get(address) ?? []).filter((at) => at > from);
    if (list.length) this.failures.set(address, list);
    else this.failures.delete(address);
    return list;
  }

  private recentOutside(): number[] {
    const from = this.now() - this.windowMs;
    if (this.outside.length && this.outside[0]! <= from) this.outside = this.outside.filter((at) => at > from);
    return this.outside;
  }

  /** Forgets the addresses with nothing recent, now and then, and past MAX_ADDRESSES those whose last failure is oldest. */
  private sweep() {
    if (this.now() - this.sweptAt >= SWEEP_EVERY_MS) {
      this.sweptAt = this.now();
      for (const address of [...this.failures.keys()]) this.recent(address);
    }
    for (const address of this.failures.keys()) {
      if (this.failures.size <= MAX_ADDRESSES) break;
      this.failures.delete(address);
    }
  }
}
