import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Search's recent searches, kept on this device for each account signed in on it (a shared iPad shows each person
 * their own), newest first. A search counts as made once one of its results is opened or played, Enter is pressed,
 * or it's left alone for a moment (SETTLED_MS): never every keystroke on the way to it.
 */

/** How many a device keeps for each account; the empty search page shows them all. */
export const MAX_RECENT_SEARCHES = 8;
/** A query left alone this long counts as searched for. */
export const SETTLED_MS = 2500;

export const RECENT_SEARCHES_KEY = 'playarr.recentSearches';

interface RecentSearches {
  /** By account id ('' before anyone has signed in), newest first. */
  byAccount: Record<string, string[]>;
}

/** The same search typed another way: case, accents and spacing aside. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** What a saved list may hold: strings, at most the limit (anything else in storage is dropped on load). */
function clean(saved: unknown): Record<string, string[]> {
  const byAccount = (saved as Partial<RecentSearches> | null)?.byAccount;
  if (!byAccount || typeof byAccount !== 'object') return {};
  return Object.fromEntries(
    Object.entries(byAccount).map(([account, list]) => [
      account,
      Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string' && !!q.trim()).slice(0, MAX_RECENT_SEARCHES) : [],
    ]),
  );
}

export const useRecentSearches = create<RecentSearches>()(
  persist(() => ({ byAccount: {} }), {
    name: RECENT_SEARCHES_KEY,
    version: 1,
    merge: (saved, current) => ({ ...current, byAccount: clean(saved) }),
  }),
);

const NONE: string[] = [];

/** The account's recent searches, newest first. */
export const useRecents = (account: string) => useRecentSearches((s) => s.byAccount[account] ?? NONE);

const update = (account: string, change: (list: string[]) => string[]) =>
  useRecentSearches.setState((s) => ({ byAccount: { ...s.byAccount, [account]: change(s.byAccount[account] ?? []) } }));

/**
 * Remember a search: first in the list, once (the same words in other capitals or accents replace it). A search that
 * only carries on from the newest one ("radio", then "radiohead") takes its place: it was typed on the way.
 */
export function recordSearch(account: string, query: string) {
  const q = query.replace(/\s+/g, ' ').trim();
  const key = fold(q);
  if (key.length < 2) return;
  update(account, (list) => {
    const rest = list.filter((r) => fold(r) !== key);
    if (rest[0] && key.startsWith(fold(rest[0]))) rest.shift();
    return [q, ...rest].slice(0, MAX_RECENT_SEARCHES);
  });
}

export const forgetSearch = (account: string, query: string) => update(account, (list) => list.filter((r) => r !== query));

export const clearSearches = (account: string) => update(account, () => []);

/** Put a list back as it was (Undo). */
export const restoreSearches = (account: string, list: string[]) => update(account, () => list.slice(0, MAX_RECENT_SEARCHES));
