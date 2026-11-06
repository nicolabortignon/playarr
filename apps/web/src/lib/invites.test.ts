import { beforeEach, describe, expect, it } from 'vitest';
import { forgetInvite, inviteFor, INVITES_KEY, rememberInvite } from './invites';

const NOW = Date.parse('2026-11-06T10:00:00Z');
const setup = (code: string, days: number) => ({ code, link: `http://nas:4000/redeem?code=${code}`, expiresAt: new Date(NOW + days * 86_400_000).toISOString() });

beforeEach(() => localStorage.removeItem(INVITES_KEY));

describe('invites made on this device', () => {
  it('keeps the newest code for each account, to copy again while it works', () => {
    rememberInvite(3, setup('AAAA2222', 7), NOW);
    rememberInvite(3, setup('BBBB3333', 7), NOW);
    rememberInvite(4, setup('CCCC4444', 7), NOW);
    expect(inviteFor(3, NOW)?.code).toBe('BBBB3333');
    expect(inviteFor(4, NOW)?.link).toBe('http://nas:4000/redeem?code=CCCC4444');
  });

  it('has none once it has expired, or for an account invited elsewhere', () => {
    rememberInvite(3, setup('AAAA2222', 7), NOW);
    expect(inviteFor(3, NOW + 8 * 86_400_000)).toBeUndefined();
    expect(inviteFor(5, NOW)).toBeUndefined();
  });

  it('forgets an account’s invite, and survives storage it can’t read', () => {
    rememberInvite(3, setup('AAAA2222', 7), NOW);
    forgetInvite(3, NOW);
    expect(inviteFor(3, NOW)).toBeUndefined();
    localStorage.setItem(INVITES_KEY, 'not json');
    expect(inviteFor(3, NOW)).toBeUndefined();
  });
});
