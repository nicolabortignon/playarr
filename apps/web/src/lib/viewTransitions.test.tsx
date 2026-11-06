import type { Album, AlbumDetail, ArtistDetail, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumCard } from '../components/Cards';
import { AlbumPage } from '../pages/Album';
import { api } from './api';
import { usePrefs } from './prefs';

const card = (id: number, title: string): Album =>
  ({ id, title, artistId: 7, artistName: 'Massive Attack', year: 1998, albumType: 'Album', secondaryTypes: [], genres: [], duration: 3780, trackCount: 11, totalTrackCount: 11 }) as Album;
const mezzanine = card(70, 'Mezzanine');
const protection = card(71, 'Protection');
const detail = (a: Album): AlbumDetail => ({ ...a, tracks: [], discCount: 1, missingTracks: [] }) as AlbumDetail;
const artist = { id: 7, name: 'Massive Attack', sortName: 'Massive Attack', genres: [], albumCount: 2, trackCount: 22, albums: [] } as ArtistDetail;

/** Home, as it can be: the same album on two shelves. */
function Shelves() {
  return (
    <>
      <section aria-label="Heard lately">
        <AlbumCard album={mezzanine} />
      </section>
      <section aria-label="Added lately">
        <AlbumCard album={protection} />
        <AlbumCard album={mezzanine} />
      </section>
    </>
  );
}

/** The elements carrying a view-transition name, by name: each name once, or the browser would skip the transition. */
function named(): Record<string, HTMLElement> {
  const entries = [...document.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.viewTransitionName).map((el) => [el.style.viewTransitionName, el] as const);
  expect(new Set(entries.map(([name]) => name)).size).toBe(entries.length);
  return Object.fromEntries(entries);
}

/** The browser's View Transitions API: what's named in the picture before the change, and after it. */
function viewTransitions() {
  const pictures: { before: Record<string, HTMLElement>; after: Record<string, HTMLElement> }[] = [];
  const start = vi.fn((update: () => Promise<void> | void) => {
    const before = named();
    const done = Promise.resolve(update()).then(() => void pictures.push({ before, after: named() }));
    return { finished: done, ready: done, updateCallbackDone: done, skipTransition() {} };
  });
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
  return { start, pictures };
}

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['album', 70], detail(mezzanine));
  client.setQueryData(['artist', 7], artist);
  const router = createMemoryRouter(
    [
      { path: '/', element: <Shelves /> },
      { path: '/albums/:id', element: <AlbumPage /> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** The cover's box on each of Mezzanine's two cards (Heard lately's, Added lately's). */
const mezzanineCovers = () => screen.getAllByRole('link', { name: /Mezzanine/ }).map((link) => link.querySelector<HTMLElement>('[data-grows]')!);
const headerCover = () => screen.getByRole('heading', { level: 1, name: 'Mezzanine' }).closest('header')!.querySelector<HTMLElement>('div > div')!;

beforeEach(() => {
  usePrefs.setState({ motion: 'full' });
  vi.spyOn(api, 'album').mockResolvedValue(detail(mezzanine));
  vi.spyOn(api, 'artist').mockResolvedValue(artist);
  vi.spyOn(api, 'requests').mockResolvedValue([]);
  vi.spyOn(api, 'health').mockResolvedValue({ ok: true, requests: true, lidarr: { ok: true } } as unknown as HealthStatus);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

describe('an album’s cover growing into its page', () => {
  it('grows from the very card it was opened from into the page’s header, which doesn’t rise as well', async () => {
    const { start, pictures } = viewTransitions();
    view();
    const [, fromAdded] = mezzanineCovers();
    fireEvent.click(within(screen.getByRole('region', { name: 'Added lately' })).getByRole('link', { name: /Mezzanine/ }));
    await waitFor(() => expect(pictures).toHaveLength(1));
    expect(start).toHaveBeenCalledOnce();
    const { before, after } = pictures[0]!;
    // Before: Added lately's card, not Heard lately's. After: the album page's cover.
    expect(before['album-cover']).toBe(fromAdded);
    expect(Object.keys(before)).toEqual(['album-cover']);
    expect(after['album-cover']).toBe(headerCover());
    expect(headerCover().className).not.toContain('animate-rise');
    // Over: nothing left named to clash with the next one.
    await waitFor(() => expect(named()).toEqual({}));
  });

  it('shrinks back into that card going back, which doesn’t rise under it', async () => {
    const { pictures } = viewTransitions();
    const router = view();
    fireEvent.click(within(screen.getByRole('region', { name: 'Added lately' })).getByRole('link', { name: /Mezzanine/ }));
    await waitFor(() => expect(pictures).toHaveLength(1));
    await screen.findByRole('heading', { level: 1, name: 'Mezzanine' });
    await act(() => router.navigate(-1));
    await waitFor(() => expect(pictures).toHaveLength(2));
    const { before, after } = pictures[1]!;
    // Before: the album page's cover. After: the card it grew from.
    expect(before['album-cover']).toBeDefined();
    expect(before['album-cover']!.closest('header')).not.toBeNull();
    const [fromHeard, fromAdded] = mezzanineCovers();
    expect(after['album-cover']).toBe(fromAdded);
    expect(after['album-cover']).not.toBe(fromHeard);
    expect(fromAdded!.closest<HTMLElement>('.animate-rise')!.style.animation).toBe('none');
    await waitFor(() => expect(named()).toEqual({}));
  });

  it('just opens the page under Reduce Motion, the header rising as usual', async () => {
    usePrefs.setState({ motion: 'reduce' });
    const { start } = viewTransitions();
    view();
    fireEvent.click(screen.getAllByRole('link', { name: /Mezzanine/ })[0]!);
    await screen.findByRole('heading', { level: 1, name: 'Mezzanine' });
    expect(start).not.toHaveBeenCalled();
    expect(named()).toEqual({});
    expect(headerCover().className).toContain('animate-rise');
  });

  it('just opens the page where the browser can’t move it', async () => {
    view();
    fireEvent.click(screen.getAllByRole('link', { name: /Mezzanine/ })[0]!);
    await screen.findByRole('heading', { level: 1, name: 'Mezzanine' });
    expect(named()).toEqual({});
    expect(headerCover().className).toContain('animate-rise');
  });
});
