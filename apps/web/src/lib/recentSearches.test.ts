import { beforeEach, describe, expect, it } from 'vitest';
import { clearSearches, forgetSearch, MAX_RECENT_SEARCHES, recordSearch, restoreSearches, useRecentSearches } from './recentSearches';

const recents = (account = '1') => useRecentSearches.getState().byAccount[account] ?? [];

beforeEach(() => useRecentSearches.setState({ byAccount: {} }));

describe('recent searches', () => {
  it('keeps the newest first, once, whatever its capitals, accents or spaces', () => {
    recordSearch('1', 'radiohead');
    recordSearch('1', 'massive attack');
    recordSearch('1', '  Radiohead ');
    expect(recents()).toEqual(['Radiohead', 'massive attack']);
    recordSearch('1', 'Björk');
    recordSearch('1', 'bjork');
    expect(recents()).toEqual(['bjork', 'Radiohead', 'massive attack']);
  });

  it('lets a search that only carries on from the newest take its place: it was typed on the way', () => {
    recordSearch('1', 'massive attack');
    recordSearch('1', 'radio');
    recordSearch('1', 'radiohead');
    expect(recents()).toEqual(['radiohead', 'massive attack']);
    // Going back to fewer letters is a search of its own.
    recordSearch('1', 'radio');
    expect(recents()).toEqual(['radio', 'radiohead', 'massive attack']);
  });

  it('ignores a letter on its own, and keeps only the last few', () => {
    recordSearch('1', 'a');
    expect(recents()).toEqual([]);
    for (let i = 0; i < MAX_RECENT_SEARCHES + 3; i++) recordSearch('1', `artist ${i} x`);
    expect(recents()).toHaveLength(MAX_RECENT_SEARCHES);
    expect(recents()[0]).toBe(`artist ${MAX_RECENT_SEARCHES + 2} x`);
  });

  it('keeps each account’s own', () => {
    recordSearch('1', 'radiohead');
    recordSearch('2', 'portishead');
    expect(recents('1')).toEqual(['radiohead']);
    expect(recents('2')).toEqual(['portishead']);
  });

  it('removes one, clears them all, and puts them back as they were', () => {
    recordSearch('1', 'radiohead');
    recordSearch('1', 'portishead');
    const before = recents();
    forgetSearch('1', 'radiohead');
    expect(recents()).toEqual(['portishead']);
    clearSearches('1');
    expect(recents()).toEqual([]);
    restoreSearches('1', before);
    expect(recents()).toEqual(['portishead', 'radiohead']);
  });
});
