import type { SetupCode } from '@playarr/shared';

/*
 * Invites made on this device, so Settings → Accounts can copy one again. The server keeps only a fingerprint of a
 * setup code (it's a password until it's used), so a link made on another device, or forgotten here, can't be copied:
 * the only way to another is a new code, which stops the old one working. Kept per account until it expires; this is
 * the admin's own device, which already keeps the session of every account signed in on it.
 */

export const INVITES_KEY = 'playarr.invites';

type Invites = Record<string, SetupCode>;

const valid = (setup: SetupCode | undefined, now: number): setup is SetupCode =>
  !!setup && typeof setup.link === 'string' && typeof setup.code === 'string' && Date.parse(setup.expiresAt) > now;

function read(now: number): Invites {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(INVITES_KEY) ?? '{}');
    if (!saved || typeof saved !== 'object') return {};
    return Object.fromEntries(Object.entries(saved as Invites).filter(([, setup]) => valid(setup, now)));
  } catch {
    return {};
  }
}

function write(invites: Invites) {
  try {
    localStorage.setItem(INVITES_KEY, JSON.stringify(invites));
  } catch {
    // Storage full or blocked: Copy invite link will make a new code instead.
  }
}

/** Keep the setup code just made for an account (added, or given a new code), until it expires. */
export function rememberInvite(accountId: number, setup: SetupCode, now = Date.now()) {
  write({ ...read(now), [accountId]: setup });
}

/** The account's invite made on this device, while it still works. */
export function inviteFor(accountId: number, now = Date.now()): SetupCode | undefined {
  return read(now)[accountId];
}

/** An account set up or removed: its invite is no use any more. */
export function forgetInvite(accountId: number, now = Date.now()) {
  const invites = read(now);
  if (!(accountId in invites)) return;
  delete invites[accountId];
  write(invites);
}
