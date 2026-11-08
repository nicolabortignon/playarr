import { describe, expect, it, vi } from 'vitest';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LibraryView } from '../library/library.ts';
import { searchDeezerTracks } from './deezer.ts';
import { Discover } from './discover.ts';
import type { MbReleaseGroup, MusicBrainz } from './musicbrainz.ts';
import type { Requests } from './requests.ts';

vi.mock('./deezer.ts', () => ({
  searchDeezerTracks: vi.fn(async () => []),
  deezerArtistTopTracks: vi.fn(async () => []),
  deezerArtistPicture: vi.fn(async () => undefined),
}));

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const credit = (id: string, name: string, joinphrase?: string) => ({ name, artist: { id, name }, ...(joinphrase ? { joinphrase } : {}) });
const album = (id: string, title: string, date: string, more: Partial<MbReleaseGroup> = {}): MbReleaseGroup => ({
  id,
  title,
  'primary-type': 'Album',
  'first-release-date': date,
  'artist-credit': [credit(RADIOHEAD, 'Radiohead')],
  ...more,
});

/** A library of the artists named, by MusicBrainz id: the library as the account searching may see it. */
const libraryOf = (artists: Record<string, number> = {}) =>
  ({ artistIdByMbid: vi.fn(async (mbid: string) => artists[mbid]), artistByName: vi.fn(async () => undefined) }) as unknown as LibraryView;
const nothing = libraryOf();

/** A Discover on a server without Lidarr, with MusicBrainz answering as `mb` says. */
function withoutLidarr(mb: Partial<Record<keyof MusicBrainz, unknown>>) {
  const lidarr = { configured: false, search: vi.fn(), artistByMbid: vi.fn(async () => Promise.reject(new Error('No Lidarr'))) };
  const requests = { availability: vi.fn(async () => ({ state: 'none' })) };
  const discover = new Discover(lidarr as unknown as LidarrClient, mb as unknown as MusicBrainz, requests as unknown as Requests);
  return { discover, lidarr, requests };
}

describe('an artist page without Lidarr', () => {
  it("takes the artist's name from MusicBrainz's credits, even when the first group it lists is a collaboration", async () => {
    const { discover } = withoutLidarr({
      artistReleaseGroups: vi.fn(async () => [
        album('collab', 'Together', '2020', { 'artist-credit': [credit('other', 'Someone', ' & '), credit(RADIOHEAD, 'Radiohead')] }),
        album('okc', 'OK Computer', '1997'),
      ]),
    });
    const page = await discover.artist(RADIOHEAD, nothing);
    expect(page.name).toBe('Radiohead');
    expect(page.albums.map((a) => a.artistName)).toEqual(['Radiohead', 'Radiohead']);
  });
});

describe('search beyond the library without Lidarr', () => {
  it('finds the artist the query names on MusicBrainz, with their albums, newest first', async () => {
    const searchAlbums = vi.fn();
    const { discover, lidarr } = withoutLidarr({
      searchArtists: vi.fn(async () => [{ id: RADIOHEAD, name: 'Radiohead', score: 100 }]),
      artistReleaseGroups: vi.fn(async () => [album('okc', 'OK Computer', '1997-05-21'), album('kida', 'Kid A', '2000-10-02')]),
      searchAlbums,
    });
    const found = await discover.search('radiohead', nothing);
    expect(found.artists.map((a) => [a.name, a.mbid])).toEqual([['Radiohead', RADIOHEAD]]);
    expect(found.albums.map((a) => [a.title, a.artistName])).toEqual([
      ['Kid A', 'Radiohead'],
      ['OK Computer', 'Radiohead'],
    ]);
    expect(lidarr.search).not.toHaveBeenCalled();
    expect(searchAlbums).not.toHaveBeenCalled();
  });

  it('finds albums by title when the query names no artist, the real one before remixes', async () => {
    const { discover } = withoutLidarr({
      searchArtists: vi.fn(async () => []),
      searchAlbums: vi.fn(async () => [
        album('8bit', 'OK Computer (8-bit)', '2012', { 'artist-credit': [credit('q', 'Quinton Sung')], 'secondary-types': ['Remix'] }),
        album('okc', 'OK Computer', '1997-05-21'),
      ]),
    });
    const found = await discover.search('ok computer', nothing);
    expect(found.albums.map((a) => a.title)).toEqual(['OK Computer', 'OK Computer (8-bit)']);
    expect(found.albums[0]).toMatchObject({ artistName: 'Radiohead', artistMbid: RADIOHEAD, year: 1997 });
  });

  it('says the search failed when neither MusicBrainz nor Deezer answers', async () => {
    vi.mocked(searchDeezerTracks).mockRejectedValueOnce(new Error('offline'));
    const { discover } = withoutLidarr({
      searchArtists: vi.fn(async () => Promise.reject(new Error('offline'))),
      searchAlbums: vi.fn(async () => Promise.reject(new Error('offline'))),
    });
    await expect(discover.search('radiohead', nothing)).rejects.toThrow(/Search failed/);
  });
});

describe('links into the library', () => {
  it('come from the library as the account searching sees it', async () => {
    const { discover, requests } = withoutLidarr({
      searchArtists: vi.fn(async () => [{ id: RADIOHEAD, name: 'Radiohead', score: 100 }]),
      artistReleaseGroups: vi.fn(async () => [album('okc', 'OK Computer', '1997-05-21')]),
    });
    const everything = libraryOf({ [RADIOHEAD]: 7 });
    expect((await discover.search('radiohead', everything)).artists[0]?.artistId).toBe(7);
    // An account that doesn't hear the source Radiohead is in gets their discography, not a page it can't open.
    const some = libraryOf();
    expect((await discover.search('radiohead', some)).artists[0]?.artistId).toBeUndefined();
    expect((await discover.artist(RADIOHEAD, some)).artistId).toBeUndefined();
    // And each album's availability is asked for that account.
    expect(requests.availability).toHaveBeenLastCalledWith('okc', some);
  });
});
