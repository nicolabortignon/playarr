import type { Album, AlbumPage, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { ALBUM_PAGE } from '../lib/queries';
import { AlbumsPage, uniqueAlbums } from './Albums';

const album = (id: number): Album => ({
  id,
  title: `Album ${id}`,
  artistId: 1,
  artistName: 'Artist',
  albumType: 'Album',
  secondaryTypes: [],
  genres: [],
  duration: 300,
  trackCount: 10,
  totalTrackCount: 10,
});
/** `count` albums from `offset`, of `total`, as the server pages them. */
const page = (offset: number, count: number, total: number, version = '1'): AlbumPage => ({
  albums: Array.from({ length: count }, (_, i) => album(offset + i + 1)),
  total,
  version,
});

/**
 * A controllable IntersectionObserver: `reveal()` says the grid's end (the sentinel after it) came into view, to
 * the newest observer watching it (covers have observers of their own).
 */
let observed: { callback: IntersectionObserverCallback; nodes: Element[] }[] = [];
const reveal = () =>
  act(() => {
    const sentinel = document.querySelector('[aria-hidden].h-px');
    const watching = observed.filter((o) => sentinel && o.nodes.includes(sentinel)).at(-1);
    watching?.callback([{ isIntersecting: true, target: sentinel! } as IntersectionObserverEntry], {} as IntersectionObserver);
  });

beforeEach(() => {
  observed = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private entry: { callback: IntersectionObserverCallback; nodes: Element[] };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, nodes: [] };
        observed.push(this.entry);
      }
      observe(node: Element) {
        this.entry.nodes.push(node);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(api, 'health').mockResolvedValue({ ok: true, requests: false } as unknown as HealthStatus);
  vi.spyOn(api, 'requests').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/albums', element: <AlbumsPage /> }], { initialEntries: ['/albums'] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const shown = () => screen.queryAllByText(/^Album \d+$/).length;

describe('the Albums page', () => {
  it('opens with the first page, says how many albums there are, and asks for the next as the end comes near', async () => {
    const pages = vi.spyOn(api, 'albumPage').mockImplementation(async (_sort, offset) => (offset === 0 ? page(0, ALBUM_PAGE, 150) : page(ALBUM_PAGE, 30, 150)));
    view();
    await waitFor(() => expect(shown()).toBe(ALBUM_PAGE));
    expect(screen.getByText('150')).toBeTruthy();
    expect(pages).toHaveBeenCalledTimes(1);
    expect(pages).toHaveBeenCalledWith('artist', 0, ALBUM_PAGE);
    reveal();
    await waitFor(() => expect(shown()).toBe(150));
    expect(pages).toHaveBeenLastCalledWith('artist', ALBUM_PAGE, ALBUM_PAGE);
    // The last page is in: nothing more to ask for.
    reveal();
    expect(pages).toHaveBeenCalledTimes(2);
  });

  it('reads every page again when the library changed between two of them', async () => {
    let version = '1';
    const pages = vi.spyOn(api, 'albumPage').mockImplementation(async (_sort, offset) => {
      const answer = offset === 0 ? page(0, ALBUM_PAGE, 150, version) : page(ALBUM_PAGE, 30, 150, version);
      version = '2';
      return answer;
    });
    view();
    await waitFor(() => expect(shown()).toBe(ALBUM_PAGE));
    reveal();
    await waitFor(() => expect(pages).toHaveBeenCalledTimes(4));
    expect(pages.mock.calls.map(([, offset]) => offset)).toEqual([0, ALBUM_PAGE, 0, ALBUM_PAGE]);
    await waitFor(() => expect(shown()).toBe(150));
  });
});

describe('uniqueAlbums', () => {
  it('keeps each album once, in the pages’ order', () => {
    expect(uniqueAlbums([page(0, 3, 5), page(2, 3, 5)]).map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
  });
});
