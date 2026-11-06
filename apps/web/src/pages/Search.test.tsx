import type { Account, Artist, DiscoverResults, HealthStatus, SearchResults } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { SETTLED_MS, useRecentSearches } from '../lib/recentSearches';
import { useToasts } from '../lib/toast';
import { SearchPage } from './Search';

const ALEX: Account = { id: 1, username: 'alex', name: 'Alex', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const NO_LIDARR: HealthStatus = { ok: true, media: { source: 'local', ok: true }, requests: false };
const RADIOHEAD = { id: 7, name: 'Radiohead', albumCount: 2, trackCount: 20 } as Artist;
const NOTHING: SearchResults = { artists: [], albums: [], tracks: [] };
const NOTHING_BEYOND: DiscoverResults = { artists: [], albums: [], tracks: [] };
const BLOOM: DiscoverResults = {
  artists: [{ mbid: 'd5cc67b8-1cc4-453b-96e8-44487acdebea', name: 'Beach House', genres: [] }],
  albums: [
    {
      mbid: '2b8a9a37-6a5f-4c8a-9f0a-2a35b2e4d3c1',
      title: 'Bloom',
      artistName: 'Beach House',
      artistMbid: 'd5cc67b8-1cc4-453b-96e8-44487acdebea',
      year: 2012,
      type: 'Album',
      secondaryTypes: [],
      availability: { state: 'none' },
    },
  ],
  tracks: [],
};

const recents = () => useRecentSearches.getState().byAccount['1'] ?? [];

function view({ q = '', search = NOTHING, beyond = NOTHING_BEYOND }: { q?: string; search?: SearchResults; beyond?: DiscoverResults } = {}) {
  vi.spyOn(api, 'me').mockResolvedValue(ALEX);
  vi.spyOn(api, 'health').mockResolvedValue(NO_LIDARR);
  vi.spyOn(api, 'requests').mockResolvedValue([]);
  vi.spyOn(api, 'playlists').mockResolvedValue([]);
  vi.spyOn(api, 'artists').mockResolvedValue([RADIOHEAD]);
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  const asked = vi.spyOn(api, 'search').mockResolvedValue(search);
  vi.spyOn(api, 'discover').mockResolvedValue(beyond);
  const router = createMemoryRouter(
    [
      { path: '/search', element: <SearchPage /> },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [q ? `/search?q=${encodeURIComponent(q)}` : '/search'] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, asked };
}

const field = () => screen.getByRole('searchbox', { name: 'Search music' });

beforeEach(() => {
  useRecentSearches.setState({ byAccount: {} });
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Search, recent searches', () => {
  it('counts a search once one of its results is opened, not each letter typed on the way', async () => {
    view({ search: { artists: [RADIOHEAD], albums: [], tracks: [] } });
    await screen.findByText('Try an artist');
    for (const typed of ['r', 'ra', 'radi', 'radiohead']) fireEvent.change(field(), { target: { value: typed } });
    const top = await screen.findByRole('link', { name: /Radiohead/ });
    expect(recents()).toEqual([]);
    fireEvent.click(top);
    expect(recents()).toEqual(['radiohead']);
  });

  it('counts a search left alone for a moment, or sent with Enter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    view();
    await screen.findByText('Try an artist');
    fireEvent.change(field(), { target: { value: 'portishead' } });
    await act(async () => vi.advanceTimersByTime(SETTLED_MS - 500));
    expect(recents()).toEqual([]);
    await act(async () => vi.advanceTimersByTime(600));
    expect(recents()).toEqual(['portishead']);
    vi.useRealTimers();
    fireEvent.change(field(), { target: { value: 'massive attack' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(recents()).toEqual(['massive attack', 'portishead']);
  });

  it('offers them on the empty page, above the artists to try: a tap searches again', async () => {
    useRecentSearches.setState({ byAccount: { '1': ['radiohead', 'portishead'] } });
    const { router } = view();
    const list = await screen.findByRole('region', { name: 'Recent searches' });
    expect(within(list).getAllByRole('button', { name: /^Search for/ }).map((b) => b.textContent)).toEqual(['radiohead', 'portishead']);
    expect(screen.getByText('Try an artist')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Search for “portishead”' }));
    expect(router.state.location.search).toBe('?q=portishead');
    expect(recents()).toEqual(['portishead', 'radiohead']);
  });

  it('removes one, or clears them all, at once, and Undo brings them back', async () => {
    useRecentSearches.setState({ byAccount: { '1': ['radiohead', 'portishead'] } });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove “radiohead” from recent searches' }));
    expect(recents()).toEqual(['portishead']);
    expect(useToasts.getState().toasts[0]!.message).toBe('Removed “radiohead” from recent searches');
    act(() => useToasts.getState().act(useToasts.getState().toasts[0]!.id));
    expect(recents()).toEqual(['radiohead', 'portishead']);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(recents()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Recent searches' })).toBeNull();
    act(() => useToasts.getState().act(useToasts.getState().toasts.at(-1)!.id));
    expect(await screen.findByRole('region', { name: 'Recent searches' })).toBeTruthy();
  });
});

describe('Search beyond the library', () => {
  it('shows what MusicBrainz has without Lidarr, marked as not in your library, with nothing to request', async () => {
    view({ q: 'beach house', beyond: BLOOM });
    expect(await screen.findByText('Not in your crates.')).toBeTruthy();
    expect(screen.getByText(/Here’s what’s out there/)).toBeTruthy();
    const beyond = await screen.findByRole('region', { name: 'Not in your library' });
    expect(within(beyond).getByText('MusicBrainz · Deezer')).toBeTruthy();
    expect(await within(beyond).findByText('Bloom')).toBeTruthy();
    expect(within(beyond).getByRole('heading', { name: 'Artists' })).toBeTruthy();
    expect(within(beyond).queryByRole('button', { name: /Request/ })).toBeNull();
  });

  it('says when it shows what’s close rather than what was typed', async () => {
    view({ q: 'radiohed', search: { artists: [RADIOHEAD], albums: [], tracks: [], near: true } });
    expect(await screen.findByText(/These come close:/)).toBeTruthy();
    expect(screen.getByText(/These come close:/).textContent).toBe('Nothing called “radiohed”. These come close:');
    expect(screen.getByText('Top result')).toBeTruthy();
  });

  it('says nothing about closeness when the results match as typed', async () => {
    view({ q: 'radiohead', search: { artists: [RADIOHEAD], albums: [], tracks: [] } });
    expect(await screen.findByText('Top result')).toBeTruthy();
    expect(screen.queryByText(/These come close/)).toBeNull();
  });

  it('ends a search with nothing anywhere with what to do next', async () => {
    view({ q: 'zzqx' });
    await waitFor(() => expect(screen.getByText(/Nothing in your library or beyond it matches “zzqx”/)).toBeTruthy());
    expect(screen.getByText('Not in your crates.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Not in your library' })).toBeNull();
    // Artists that are here, and a way back to the recent searches.
    expect(await screen.findByRole('link', { name: 'Radiohead' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New search' }));
    expect(field()).toHaveProperty('value', '');
  });
});
