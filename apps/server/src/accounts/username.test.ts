import { describe, expect, it } from 'vitest';
import { USERNAME, usernameFrom } from './username.ts';

describe('usernameFrom', () => {
  it('makes a lowercase username from a display name, numbered when taken', () => {
    expect(usernameFrom('Zoë B.', new Set())).toBe('zoe-b');
    expect(usernameFrom('  Nicola  ', new Set())).toBe('nicola');
    expect(usernameFrom('!!!', new Set())).toBe('listener');
    expect(usernameFrom('Home', new Set(['home', 'home-2']))).toBe('home-3');
    expect(usernameFrom('A'.repeat(50), new Set())).toHaveLength(28);
    for (const name of ['Zoë B.', 'Home', 'A'.repeat(50), '!!!']) expect(USERNAME.test(usernameFrom(name, new Set()))).toBe(true);
  });
});
