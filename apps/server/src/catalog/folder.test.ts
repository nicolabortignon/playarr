import { describe, expect, it } from 'vitest';
import { describeFile, FOLDER_META_RANK, folderSync, type FolderEntry } from './folder.ts';
import type { MbReleaseInfo } from './mbRelease.ts';
import { CatalogStore } from './store.ts';
import type { TagInfo } from './tags.ts';
import { FLAC, freshDb, mezzanine } from './testFixtures.ts';
import type { NameIndex } from './types.ts';

const EMPTY: NameIndex = { artists: new Map(), albums: new Map(), tracks: new Map(), songs: new Map() };

function entry(rel: string, tags: Partial<TagInfo> = {}): FolderEntry {
  return {
    rel,
    path: `/music/${rel}`,
    size: 1000,
    mtimeMs: Date.UTC(2026, 9, 1),
    tags: { genres: [], duration: 200, format: FLAC, ...tags },
  };
}

function lidarrIndex() {
  const store = new CatalogStore(freshDb());
  store.applySync(store.addSource('lidarr', 'Lidarr'), mezzanine());
  return store.nameIndex();
}

describe('folderSync', () => {
  it('uses MusicBrainz ids from tags', () => {
    const sync = folderSync(
      [
        entry('Massive Attack/Mezzanine/01 Angel.flac', {
          title: 'Angel',
          albumArtist: 'Massive Attack',
          album: 'Mezzanine',
          trackNumber: 1,
          trackTotal: 11,
          recordingMbid: 'rec-1',
          releaseGroupMbid: 'rg-1',
          albumArtistMbid: 'art-1',
        }),
      ],
      EMPTY,
    );
    expect(sync.metaRank).toBe(FOLDER_META_RANK);
    expect(sync.artists).toEqual([expect.objectContaining({ key: 'mb:art-1', name: 'Massive Attack' })]);
    expect(sync.albums).toEqual([expect.objectContaining({ key: 'mb:rg-1', title: 'Mezzanine', totalTrackCount: 11 })]);
    expect(sync.tracks).toEqual([expect.objectContaining({ key: 'mb:rg-1#rec-1', recordingId: 'rec-1', trackNumber: 1 })]);
    expect(sync.copies).toEqual([
      expect.objectContaining({
        ref: 'Massive Attack/Mezzanine/01 Angel.flac',
        path: '/music/Massive Attack/Mezzanine/01 Angel.flac',
        trackKey: 'mb:rg-1#rec-1',
        addedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);
  });

  it('falls back to folder and file names', () => {
    const sync = folderSync([entry('Portishead/1994 - Dummy/03 - Sour Times.flac')], EMPTY);
    expect(sync.artists[0]).toMatchObject({ name: 'Portishead' });
    expect(sync.albums[0]).toMatchObject({ title: 'Dummy', albumType: 'Album' });
    expect(sync.albums[0]!.key.startsWith('name:')).toBe(true);
    expect(sync.tracks[0]).toMatchObject({ title: 'Sour Times', trackNumber: 3, discNumber: 1 });
    expect(sync.tracks[0]!.recordingId).toMatch(/^local:/);
  });

  it('gives untagged songs a stable id', () => {
    const a = folderSync([entry('Portishead/Dummy/03 Sour Times.flac')], EMPTY);
    const b = folderSync([entry('Elsewhere/Portishead/Dummy/Sour Times.flac')], EMPTY);
    expect(b.tracks[0]!.recordingId).toBe(a.tracks[0]!.recordingId);
  });

  it('groups songs without an album as loose songs of their artist', () => {
    const sync = folderSync([entry('Burial/Archangel.flac')], EMPTY);
    expect(sync.albums[0]).toMatchObject({ title: 'Loose songs', albumType: 'Loose' });
    expect(sync.albums[0]!.key).toBe(`loose:${sync.artists[0]!.key}`);
  });

  it('joins untagged files to the library by name', () => {
    const sync = folderSync([entry('Massive Attack/Mezzanine/01 Angel.flac')], lidarrIndex());
    expect(sync.artists[0]!.key).toBe('mb:art-1');
    expect(sync.albums[0]!.key).toBe('mb:rg-1');
    expect(sync.tracks[0]).toMatchObject({ key: 'mb:rg-1#rec-1', recordingId: 'rec-1' });
    expect(sync.copies[0]!.trackKey).toBe('mb:rg-1#rec-1');
  });

  it('files a loose song under the album the library has it on', () => {
    const sync = folderSync([entry('Massive Attack/Angel.flac')], lidarrIndex());
    expect(sync.albums.map((a) => a.key)).toEqual(['mb:rg-1']);
    expect(sync.copies[0]!.trackKey).toBe('mb:rg-1#rec-1');
  });

  it('collects genres and the release year', () => {
    const sync = folderSync(
      [
        entry('A/B/1.flac', { album: 'B', albumArtist: 'A', genres: ['Rock', 'Indie'], year: 2001 }),
        entry('A/B/2.flac', { album: 'B', albumArtist: 'A', genres: ['Rock', 'Shoegaze', 'Noise'] }),
      ],
      EMPTY,
    );
    expect(sync.albums).toHaveLength(1);
    expect(sync.albums[0]).toMatchObject({ genres: ['Rock', 'Indie', 'Shoegaze'], releaseDate: '2001-01-01T00:00:00Z' });
  });

  const mbMezzanine: MbReleaseInfo = {
    id: 'rel-1',
    title: 'Mezzanine',
    artistName: 'Massive Attack',
    artistId: 'art-1',
    releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
    tracks: [
      { disc: 1, position: 1, title: 'Angel', length: 379, recordingId: 'rec-1' },
      { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
    ],
  };

  it('describes a file from its tags or its name', () => {
    expect(describeFile('Portishead/1994 - Dummy/03 - Sour Times.flac', { genres: [], duration: 250, format: FLAC })).toEqual({
      artistName: 'Portishead',
      albumTitle: 'Dummy',
      title: 'Sour Times',
      trackNumber: 3,
      discNumber: 1,
      duration: 250,
    });
  });

  it('reports the rest of a matched release as missing songs, with MusicBrainz metadata', () => {
    const sync = folderSync(
      [
        entry('x/01.flac', {
          title: 'Angel',
          album: 'Mezzanine',
          albumArtist: 'Massive Attack',
          albumArtistMbid: 'art-1',
          recordingMbid: 'rec-1',
          releaseGroupMbid: 'rg-1',
          releaseId: 'rel-1',
          trackNumber: 1,
        }),
      ],
      EMPTY,
      new Map([['rel-1', mbMezzanine]]),
    );
    expect(sync.albums[0]).toMatchObject({ key: 'mb:rg-1', title: 'Mezzanine', releaseDate: '1998-04-17', totalTrackCount: 2, metaRank: 1 });
    expect(sync.tracks.map((t) => [t.key, t.metaRank])).toEqual([
      ['mb:rg-1#rec-1', 1],
      ['mb:rg-1#rec-2', 1],
    ]);
    expect(sync.copies).toHaveLength(1);
  });
});
