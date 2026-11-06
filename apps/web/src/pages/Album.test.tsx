import type { AlbumDetail, ArtistDetail, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { AlbumPage } from './Album';

const album = (over: Partial<AlbumDetail> = {}): AlbumDetail => ({
  id: 70,
  title: 'Mezzanine',
  artistId: 7,
  artistName: 'Massive Attack',
  year: 1998,
  albumType: 'Album',
  secondaryTypes: [],
  genres: [],
  duration: 3780,
  trackCount: 11,
  totalTrackCount: 11,
  addedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  tracks: [],
  discCount: 1,
  missingTracks: [],
  ...over,
});

const artist: ArtistDetail = {
  id: 7,
  name: 'Massive Attack',
  sortName: 'Massive Attack',
  genres: [],
  albumCount: 1,
  trackCount: 11,
  albums: [],
};

beforeEach(() => {
  vi.spyOn(api, 'artist').mockResolvedValue(artist);
  vi.spyOn(api, 'requests').mockResolvedValue([]);
  vi.spyOn(api, 'health').mockResolvedValue({ ok: true, requests: true, lidarr: { ok: true } } as unknown as HealthStatus);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderAlbum(detail: AlbumDetail) {
  vi.spyOn(api, 'album').mockResolvedValue(detail);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/albums/:id', element: <AlbumPage /> }], { initialEntries: ['/albums/70'] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const title = await screen.findByRole('heading', { level: 1, name: detail.title });
  return title.closest('header')!;
}

describe('Album page header', () => {
  it('says what kind of release it is, then one line: artist, year, songs and length', async () => {
    const header = within(await renderAlbum(album()));
    expect(header.getByText('Album')).toBeTruthy();
    expect(header.getByRole('link', { name: 'Massive Attack' }).getAttribute('href')).toBe('/artists/7');
    expect(header.getByText('1998')).toBeTruthy();
    expect(header.getByText('11 songs')).toBeTruthy();
    expect(header.getByText('1 hr 3 min')).toBeTruthy();
    // When it was added isn't part of the album.
    expect(header.queryByText(/added/)).toBeNull();
  });

  it('names its ⋯ for the album, as every ⋯ is named for what it’s about', async () => {
    const header = within(await renderAlbum(album()));
    expect(header.getByRole('button', { name: `More for “${album().title}”` }).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('names a live album as one, the kicker saying only what it is', async () => {
    const header = within(await renderAlbum(album({ secondaryTypes: ['Live'] })));
    // An exact match: no year beside it ("Live · 1998" before).
    expect(header.getByText('Live album')).toBeTruthy();
  });

  it('counts the songs that are here, leaving the missing ones to the list and the row', async () => {
    const header = within(await renderAlbum(album({ trackCount: 9, totalTrackCount: 11 })));
    expect(header.getByText('9 songs')).toBeTruthy();
    expect(header.queryByText(/missing/)).toBeNull();
    expect(header.getByRole('button', { name: 'Request the rest' })).toBeTruthy();
  });
});
