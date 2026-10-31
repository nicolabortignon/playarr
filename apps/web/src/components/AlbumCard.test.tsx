import type { Album, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { AlbumCard } from './Cards';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const album = (over: Partial<Album> = {}): Album => ({
  id: 70,
  title: 'Mezzanine',
  artistId: 7,
  artistName: 'Massive Attack',
  albumType: 'Album',
  secondaryTypes: [],
  genres: [],
  duration: 379,
  trackCount: 1,
  totalTrackCount: 11,
  mbid: 'rg-1',
  ...over,
});

beforeEach(() => {
  vi.spyOn(api, 'health').mockResolvedValue({ ok: true, requests: true, lidarr: { ok: true } } as unknown as HealthStatus);
  vi.spyOn(api, 'requests').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderCard(a: Album) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: '/', element: <AlbumCard album={a} /> },
    { path: '/albums/:id', element: <p>album page</p> },
  ]);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('AlbumCard', () => {
  it('offers the rest of an incomplete album, without opening it', async () => {
    const request = vi.spyOn(api, 'requestAlbum').mockResolvedValue({
      mbid: 'rg-1',
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      requestedAt: new Date().toISOString(),
      availability: { state: 'searching' },
    });
    const router = renderCard(album());
    fireEvent.click(await screen.findByRole('button', { name: /request/i }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ mbid: 'rg-1', artistName: 'Massive Attack', albumTitle: 'Mezzanine' }));
    expect(router.state.location.pathname).toBe('/');
  });

  it('requests an album known only from its tags by artist and title', async () => {
    const request = vi.spyOn(api, 'requestAlbum').mockResolvedValue({
      mbid: 'rg-1',
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      requestedAt: new Date().toISOString(),
      availability: { state: 'searching' },
    });
    renderCard(album({ mbid: undefined }));
    fireEvent.click(await screen.findByRole('button', { name: /request/i }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ artistName: 'Massive Attack', albumTitle: 'Mezzanine' }));
  });

  it('shows the progress of a request made by name', async () => {
    vi.mocked(api.requests).mockResolvedValue([
      { mbid: 'rg-1', title: 'Mezzanine', artistName: 'Massive Attack', requestedAt: new Date().toISOString(), availability: { state: 'searching' } },
    ]);
    renderCard(album({ mbid: undefined }));
    expect(await screen.findByText(/searching/i)).toBeTruthy();
  });

  it('has no Request for a complete album, or an artist’s loose songs', async () => {
    renderCard(album({ trackCount: 11 }));
    await screen.findByText('Mezzanine');
    expect(screen.queryByRole('button', { name: /request/i })).toBeNull();
    cleanup();
    renderCard(album({ title: 'Loose songs', albumType: 'Loose', trackCount: 3, totalTrackCount: 5 }));
    await screen.findByText('Loose songs');
    expect(screen.queryByRole('button', { name: /request/i })).toBeNull();
  });

  it('keeps only its size while far off screen, and comes back when scrolled near', () => {
    const watched: { margin: string; callback: IntersectionObserverCallback; nodes: Element[] }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private o: (typeof watched)[number];
        constructor(callback: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
          watched.push((this.o = { margin: opts?.rootMargin ?? '', callback, nodes: [] }));
        }
        observe(el: Element) {
          this.o.nodes.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      renderCard(album({ trackCount: 11 }));
      const far = watched.find((o) => o.margin === '300% 0px')!;
      const card = far.nodes[0] as HTMLElement;
      const report = (isIntersecting: boolean) =>
        act(() => far.callback([{ target: card, isIntersecting, boundingClientRect: { height: 280 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(screen.getByText('Mezzanine')).toBeTruthy();
      report(false);
      expect(screen.queryByText('Mezzanine')).toBeNull();
      expect(card.style.height).toBe('280px');
      report(true);
      expect(screen.getByText('Mezzanine')).toBeTruthy();
      expect(card.style.height).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
