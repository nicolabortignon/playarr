/**
 * Failed tries per key (an address, a username) within a sliding window: past `max`, a key is refused
 * until its oldest failure is `windowMs` old. In memory: a restart forgives, which is fine at home.
 */
export class RateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when none of the keys has used up its tries. */
  allows(keys: string[]): boolean {
    return keys.every((key) => this.recent(key).length < this.max);
  }

  fail(keys: string[]) {
    const at = this.now();
    for (const key of keys) this.failures.set(key, [...this.recent(key), at]);
  }

  clear(key: string) {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const from = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((at) => at > from);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}
