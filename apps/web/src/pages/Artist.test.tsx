import type { Album, ArtistDetail, DiscoverAlbum, DiscoverArtistDetail, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { artistPhoto, ArtistPage } from './Artist';

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

const discovered = (mbid: string, title: string, availability: DiscoverAlbum['availability'], type = 'Album', year?: number): DiscoverAlbum => ({
  mbid,
  title,
  artistName: 'Massive Attack',
  artistMbid: 'art-1',
  type,
  secondaryTypes: [],
  availability,
  year,
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
        discovered('rg-blue', 'Blue Lines', { state: 'none' }, 'Album', 1991),
        discovered('rg-heli', 'Heligoland', { state: 'partial', albumId: 71, have: 2, total: 10 }),
        discovered('rg-ep', 'Ritual Spirit', { state: 'none' }, 'EP', 2016),
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

  it('says what each album not in the library is and when, rather than the artist’s own name', async () => {
    vi.spyOn(api, 'artist').mockResolvedValue(artist());
    vi.spyOn(api, 'discoverArtist').mockResolvedValue({
      mbid: 'art-1',
      name: 'Massive Attack',
      albums: [discovered('rg-blue', 'Blue Lines', { state: 'none' }, 'Album', 1991), discovered('rg-ep', 'Ritual Spirit', { state: 'none' }, 'EP', 2016)],
    } as DiscoverArtistDetail);
    renderArtist();
    const albums = within((await screen.findByText('Albums not in your library')).closest('section')!);
    expect(albums.getByText('Album · 1991')).toBeTruthy();
    expect(albums.queryByText('Massive Attack')).toBeNull();
    // Nor a badge on the cover saying it again.
    expect(albums.queryByText('Album')).toBeNull();
    const eps = within(screen.getByText('EPs & soundtracks not in your library').closest('section')!);
    expect(eps.getByText('EP · 2016')).toBeTruthy();
  });

  it('heads the page with what it is, the name and one line of counts', async () => {
    vi.spyOn(api, 'artist').mockResolvedValue(artist({ mbid: undefined, albumCount: 2, trackCount: 24 }));
    renderArtist();
    const header = within((await screen.findByRole('heading', { level: 1, name: 'Massive Attack' })).closest('header')!);
    expect(header.getByText('Artist')).toBeTruthy();
    expect(header.getByText('2 albums')).toBeTruthy();
    expect(header.getByText('24 songs')).toBeTruthy();
    expect(header.getByRole('button', { name: 'Play Massive Attack' })).toBeTruthy();
    // A person's name, as accounts', goes without quotes.
    expect(header.getByRole('button', { name: 'More for Massive Attack' })).toBeTruthy();
  });

  it('draws a photo behind the name, and shows an album cover beside it when there’s no photo', async () => {
    const cover = '/art/album/70/cover';
    const withAlbum = artist({ mbid: undefined, albums: [{ ...owned(70, 'Mezzanine', 'rg-mezz'), coverUrl: cover }] });
    vi.spyOn(api, 'artist').mockResolvedValue({ ...withAlbum, imageUrl: cover });
    renderArtist();
    const header = (await screen.findByRole('heading', { level: 1, name: 'Massive Attack' })).closest('header')!;
    // The server's fallback picture is an album cover, not a photo: it's the round picture in the header.
    expect(header.querySelector(`img[src^="${cover}"]`)).toBeTruthy();
    cleanup();

    vi.spyOn(api, 'artist').mockResolvedValue({ ...withAlbum, imageUrl: cover, fanartUrl: '/art/artist/7/fanart' });
    renderArtist();
    const hero = (await screen.findByRole('heading', { level: 1, name: 'Massive Attack' })).closest('section')!;
    expect(hero.querySelector('img[src^="/art/artist/7/fanart"]')).toBeTruthy();
  });
});

describe('artistPhoto', () => {
  it('is the artist’s picture unless that is only one of their album covers', () => {
    const albums = [{ coverUrl: '/art/album/70/cover' }] as ArtistDetail['albums'];
    expect(artistPhoto({ imageUrl: '/art/artist/7/poster', albums })).toBe('/art/artist/7/poster');
    expect(artistPhoto({ imageUrl: '/art/album/70/cover', albums })).toBeUndefined();
    expect(artistPhoto({ albums })).toBeUndefined();
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
