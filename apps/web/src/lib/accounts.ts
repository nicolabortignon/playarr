import type { Account, SignInResponse } from '@playarr/shared';
import { create } from 'zustand';
import { api, ApiError } from './api';
import { API_CACHE } from './cacheNames';
import { queryClient } from './queryClient';

/** An account signed in on this device: its session token, which the cookie is set to when it listens. */
export interface StoredAccount {
  accountId: number;
  name: string;
  username: string;
  token: string;
}

export const ACCOUNTS_KEY = 'playarr.accounts';

const isStored = (v: unknown): v is StoredAccount => {
  const a = v as Partial<StoredAccount> | null;
  return !!a && typeof a === 'object' && Number.isInteger(a.accountId) && typeof a.name === 'string' && typeof a.username === 'string' && typeof a.token === 'string';
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

/** Keep a fresh sign-in on this device (replacing that account's earlier one). */
export function remember({ token, account }: SignInResponse) {
  const others = useAccounts.getState().accounts.filter((a) => a.accountId !== account.id);
  save([...others, { accountId: account.id, name: account.name, username: account.username, token }]);
}

export function forget(accountId: number) {
  save(useAccounts.getState().accounts.filter((a) => a.accountId !== accountId));
}

/**
 * Listen as this account on this device: its session becomes the cookie, and nothing of the last
 * account stays on screen or in the offline fallback. An ended session is forgotten.
 */
export async function switchTo(accountId: number): Promise<Account> {
  const stored = useAccounts.getState().accounts.find((a) => a.accountId === accountId);
  if (!stored) throw new Error('That account isn’t signed in on this device');
  try {
    const account = await api.switchAccount(stored.token);
    save(useAccounts.getState().accounts.map((a) => (a.accountId === accountId ? { ...a, name: account.name, username: account.username } : a)));
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
  return switchTo(response.account.id);
}

/** Sign this device out of the account it listens as. */
export async function signOut() {
  const me = queryClient.getQueryData<Account>(['me']);
  await api.signOut().catch(() => {});
  if (me) forget(me.id);
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
