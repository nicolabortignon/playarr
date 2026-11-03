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

  it('gives every address a budget of its own', () => {
    const limiter = new RateLimiter(2, 1000, () => 0);
    limiter.fail('1.2.3.4');
    limiter.fail('1.2.3.4');
    expect(limiter.allows('1.2.3.4')).toBe(false);
    expect(limiter.allows('5.6.7.8')).toBe(true);
    limiter.fail('5.6.7.8');
    expect(limiter.allows('5.6.7.8')).toBe(true);
  });
});
