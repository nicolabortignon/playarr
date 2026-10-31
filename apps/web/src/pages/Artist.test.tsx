import type { Album, ArtistDetail, DiscoverAlbum, DiscoverArtistDetail, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { ArtistPage } from './Artist';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const owned = (id: number, title: string, mbid: string): Album => ({
  id,
  title,
  artistId: 7,
  artistName: 'Massive Attack',
  albumType: 'Album',
  secondaryTypes: [],
  genres: [],
  duration: 3000,
  trackCount: 10,
  totalTrackCount: 10,
  mbid,
});

const discovered = (mbid: string, title: string, availability: DiscoverAlbum['availability'], type = 'Album'): DiscoverAlbum => ({
  mbid,
  title,
  artistName: 'Massive Attack',
  artistMbid: 'art-1',
  type,
  secondaryTypes: [],
  availability,
});

const artist = (over: Partial<ArtistDetail> = {}): ArtistDetail => ({
  id: 7,
  name: 'Massive Attack',
  sortName: 'Massive Attack',
  genres: [],
  albumCount: 1,
  trackCount: 10,
  mbid: 'art-1',
  albums: [owned(70, 'Mezzanine', 'rg-mezz')],
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

function renderArtist() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/artists/:id', element: <ArtistPage /> }], { initialEntries: ['/artists/7'] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Artist page', () => {
  it('lists the albums not in the library, each with Request', async () => {
    vi.spyOn(api, 'artist').mockResolvedValue(artist());
    vi.spyOn(api, 'discoverArtist').mockResolvedValue({
      mbid: 'art-1',
      name: 'Massive Attack',
      albums: [
        discovered('rg-mezz', 'Mezzanine', { state: 'available', albumId: 70 }),
        discovered('rg-blue', 'Blue Lines', { state: 'none' }),
        discovered('rg-heli', 'Heligoland', { state: 'partial', albumId: 71, have: 2, total: 10 }),
        discovered('rg-ep', 'Ritual Spirit', { state: 'none' }, 'EP'),
      ],
    } as DiscoverArtistDetail);
    renderArtist();
    const albums = (await screen.findByText('Albums not in your library')).closest('section')!;
    expect(within(albums).getByText('Blue Lines')).toBeTruthy();
    expect(within(albums).getByRole('button', { name: /request/i })).toBeTruthy();
    // Owned and partly owned albums stay in the library sections, not here.
    expect(within(albums).queryByText('Mezzanine')).toBeNull();
    expect(within(albums).queryByText('Heligoland')).toBeNull();
    expect(screen.getByText('EPs & soundtracks not in your library').closest('section')!.textContent).toContain('Ritual Spirit');
  });

  it('skips the section for artists MusicBrainz doesn’t know', async () => {
    vi.spyOn(api, 'artist').mockResolvedValue(artist({ mbid: undefined }));
    const discover = vi.spyOn(api, 'discoverArtist');
    renderArtist();
    await screen.findAllByText('Mezzanine');
    expect(discover).not.toHaveBeenCalled();
    expect(screen.queryByText(/not in your library/)).toBeNull();
  });
});
