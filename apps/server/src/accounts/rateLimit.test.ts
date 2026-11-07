import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit.ts';

describe('RateLimiter', () => {
  it('refuses an address after too many failures, until they are old enough', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(limiter.allows('1.2.3.4')).toBe(true);
      limiter.fail('1.2.3.4');
      now += 100;
    }
    expect(limiter.allows('1.2.3.4')).toBe(false);
    now = 1001; // the first failure has aged out
    expect(limiter.allows('1.2.3.4')).toBe(true);
  });

  it('counts every try with take, not only the failed ones', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.take('1.2.3.4')).toBe(true);
    expect(limiter.take('1.2.3.4')).toBe(true);
    expect(limiter.take('1.2.3.4')).toBe(false);
    expect(limiter.take('5.6.7.8')).toBe(true);
    now = 1001;
    expect(limiter.take('1.2.3.4')).toBe(true);
  });

  it('gives every address a budget of its own', () => {
    const limiter = new RateLimiter(2, 1000, () => 0);
    limiter.fail('1.2.3.4');
    limiter.fail('1.2.3.4');
    expect(limiter.allows('1.2.3.4')).toBe(false);
    expect(limiter.allows('5.6.7.8')).toBe(true);
    limiter.fail('5.6.7.8');
    expect(limiter.allows('5.6.7.8')).toBe(true);
  });

  it('refuses everyone outside the home network once they’ve failed too often between them, but never the home network', () => {
    let now = 0;
    const limiter = new RateLimiter(10, 1000, () => now, 5);
    // Guessing spread over many addresses, each well within its own budget.
    for (let i = 1; i <= 5; i++) limiter.fail(`203.0.113.${i}`);
    expect(limiter.allows('198.51.100.7')).toBe(false);
    expect(limiter.allows('203.0.113.1')).toBe(false);
    // At home, only each address's own budget counts.
    expect(limiter.allows('192.168.1.20')).toBe(true);
    expect(limiter.allows('::1')).toBe(true);
    limiter.fail('192.168.1.20');
    expect(limiter.allows('192.168.1.20')).toBe(true);
    now = 1001;
    expect(limiter.allows('198.51.100.7')).toBe(true);
  });

  it('forgets addresses with nothing recent, and keeps at most 10,000', () => {
    let now = 0;
    const limiter = new RateLimiter(10, 1000, () => now, Number.POSITIVE_INFINITY);
    for (let i = 0; i < 50; i++) limiter.fail(`10.0.0.${i}`);
    expect(limiter.size).toBe(50);
    // A minute on, the next failure sweeps the ones whose failures have aged out.
    now = 61_000;
    limiter.fail('10.0.1.1');
    expect(limiter.size).toBe(1);
    for (let i = 0; i < 10_050; i++) limiter.fail(`198.18.${i >> 8}.${i & 255}`);
    expect(limiter.size).toBe(10_000);
    // The ones failing most lately are kept.
    expect(limiter.allows('198.18.39.65')).toBe(true);
  });
});
