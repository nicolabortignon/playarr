import type { Album, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('has no Request for a complete album, or one MusicBrainz doesn’t know', async () => {
    renderCard(album({ trackCount: 11 }));
    await screen.findByText('Mezzanine');
    expect(screen.queryByRole('button', { name: /request/i })).toBeNull();
    cleanup();
    renderCard(album({ mbid: undefined }));
    await screen.findByText('Mezzanine');
    expect(screen.queryByRole('button', { name: /request/i })).toBeNull();
  });
});
