import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit.ts';

describe('RateLimiter', () => {
  it('refuses a key after too many failures, until they are old enough', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    const keys = ['ip:1.2.3.4', 'user:sam'];
    for (let i = 0; i < 3; i++) {
      expect(limiter.allows(keys)).toBe(true);
      limiter.fail(keys);
      now += 100;
    }
    expect(limiter.allows(keys)).toBe(false);
    expect(limiter.allows(['user:sam'])).toBe(false);
    expect(limiter.allows(['user:zoe'])).toBe(true);
    now = 1001; // the first failure has aged out
    expect(limiter.allows(keys)).toBe(true);
  });

  it('forgets a key that is cleared', () => {
    const limiter = new RateLimiter(1, 1000, () => 0);
    limiter.fail(['user:sam']);
    expect(limiter.allows(['user:sam'])).toBe(false);
    limiter.clear('user:sam');
    expect(limiter.allows(['user:sam'])).toBe(true);
  });
});
