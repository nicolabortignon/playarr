import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

describe('passwords', () => {
  it('hashes each password with a salt of its own, and checks it', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('Correct horse', a)).toBe(false);
  });

  it('refuses anything it can’t read', async () => {
    const a = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', 'garbage')).toBe(false);
    expect(await verifyPassword('correct horse', a.replace('$16384$', '$3$'))).toBe(false);
    expect(await verifyPassword('correct horse', a.slice(0, -8))).toBe(false);
  });
});
