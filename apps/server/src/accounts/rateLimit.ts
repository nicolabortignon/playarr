/**
 * Failed tries per client address within a sliding window (or every try, with `take`): past `max`, an
 * address is refused until its oldest one is `windowMs` old. Only addresses count, never usernames, so
 * someone guessing at a username can't lock its owner out. In memory: a restart forgives, which is fine
 * at home.
 */
export class RateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while the address has tries left. */
  allows(address: string): boolean {
    return this.recent(address).length < this.max;
  }

  fail(address: string) {
    this.failures.set(address, [...this.recent(address), this.now()]);
  }

  /** For a limit on every try, not only the failed ones: false when the address has none left, else counts this one. */
  take(address: string): boolean {
    if (!this.allows(address)) return false;
    this.fail(address);
    return true;
  }

  private recent(address: string): number[] {
    const from = this.now() - this.windowMs;
    const list = (this.failures.get(address) ?? []).filter((at) => at > from);
    if (list.length) this.failures.set(address, list);
    else this.failures.delete(address);
    return list;
  }
}
