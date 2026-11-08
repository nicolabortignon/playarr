import type { Account, SignInResponse } from '@playarr/shared';
import { create } from 'zustand';
import { api, ApiError } from './api';
import { API_CACHE } from './cacheNames';
import { queryClient } from './queryClient';

/**
 * An account signed in on this device. Its session token isn't here: the server keeps it in this browser as a cookie
 * no script can read (playarr_kept_<id>, sent only to /api/auth), and makes it the session cookie on switching.
 */
export interface StoredAccount {
  accountId: number;
  name: string;
  username: string;
  /** Kept here by an older version, until it's handed over to the server (`keepTokens`). */
  token?: string;
}

export const ACCOUNTS_KEY = 'playarr.accounts';

const isStored = (v: unknown): v is StoredAccount => {
  const a = v as Partial<StoredAccount> | null;
  return (
    !!a &&
    typeof a === 'object' &&
    Number.isInteger(a.accountId) &&
    typeof a.name === 'string' &&
    typeof a.username === 'string' &&
    (a.token === undefined || typeof a.token === 'string')
  );
};

function read(): StoredAccount[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(isStored) : [];
  } catch {
    return [];
  }
}

/** The accounts signed in on this device. */
export const useAccounts = create<{ accounts: StoredAccount[] }>(() => ({ accounts: read() }));

function save(accounts: StoredAccount[]) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    // Storage full or blocked: this visit still works, the next asks to sign in again.
  }
  useAccounts.setState({ accounts });
}

/** List a fresh sign-in on this device (replacing that account's earlier one); its token goes to the server on switching. */
export function remember({ account }: Pick<SignInResponse, 'account'>) {
  const others = useAccounts.getState().accounts.filter((a) => a.accountId !== account.id);
  save([...others, { accountId: account.id, name: account.name, username: account.username }]);
}

/** The account as it's listed now, without a token: the server keeps that. */
const listed = (accountId: number, account: Pick<Account, 'name' | 'username'>): StoredAccount => ({
  accountId,
  name: account.name,
  username: account.username,
});

export function forget(accountId: number) {
  save(useAccounts.getState().accounts.filter((a) => a.accountId !== accountId));
}

/**
 * Listen as this account on this device: its session becomes the cookie, and nothing of the last
 * account stays on screen or in the offline fallback. An ended session is forgotten. `token`: one just signed in with;
 * otherwise the one the server keeps for the account in this browser (or an older version kept here).
 */
export async function switchTo(accountId: number, token?: string): Promise<Account> {
  const stored = useAccounts.getState().accounts.find((a) => a.accountId === accountId);
  if (!stored) throw new Error('That account isn’t signed in on this device');
  try {
    const given = token ?? stored.token;
    const account = await api.switchAccount(given ? { token: given } : { accountId });
    // The server keeps the token from now on.
    save(useAccounts.getState().accounts.map((a) => (a.accountId === accountId ? listed(accountId, account) : a)));
    // The service worker's offline copies of API answers were the last account's.
    if (typeof caches !== 'undefined') await caches.delete(API_CACHE).catch(() => false);
    await queryClient.resetQueries();
    return account;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) forget(accountId);
    throw err;
  }
}

/** After signing in, redeeming a code or setting up the server: keep the account and listen as it. */
export async function signedIn(response: SignInResponse): Promise<Account> {
  remember(response);
  return switchTo(response.account.id, response.token);
}

/**
 * The tokens an older version kept in localStorage, in the clear: each is handed over to the server, which keeps it as
 * a cookie no script can read, and leaves localStorage then. One that has ended is forgotten; one that can't be handed
 * over now (offline, say) waits for the next visit.
 */
export async function keepTokens() {
  for (const { accountId, token } of useAccounts.getState().accounts) {
    if (!token) continue;
    try {
      const account = await api.keepSignIn(token);
      save(useAccounts.getState().accounts.map((a) => (a.accountId === accountId ? listed(accountId, account) : a)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) forget(accountId);
    }
  }
}

/** Sign this device out of the account it listens as. */
export async function signOut() {
  const me = queryClient.getQueryData<Account>(['me']);
  await api.signOut().catch(() => {});
  if (me) forget(me.id);
  // The service worker's offline copies of API answers were this account's.
  if (typeof caches !== 'undefined') await caches.delete(API_CACHE).catch(() => false);
  queryClient.clear();
}

/** "Safari on iPhone": how this device is listed under an account's sessions. */
export function deviceName(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'a computer';
  return `${browser} on ${device}`;
}
