import { describe, expect, it, vi } from 'vitest';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrAlbum, LidarrArtist, LidarrTrack, LidarrTrackFile } from '../lidarr/types.ts';
import { buildCatalog } from './build.ts';
import { LidarrSource, timeSpanSeconds } from './lidarr.ts';
import { CatalogStore } from './store.ts';
import { freshDb } from './testFixtures.ts';

const artist = (id: number, name: string, mbid: string, files: number): LidarrArtist => ({
  id,
  artistName: name,
  foreignArtistId: mbid,
  genres: ['trip hop'],
  images: [{ coverType: 'poster', url: `/MediaCover/${id}/poster.jpg?lastWrite=123` }],
  path: `/music/${name}`,
  statistics: { trackFileCount: files, trackCount: files, totalTrackCount: files, sizeOnDisk: 0, percentOfTracks: 100 },
});
const album = (id: number, artistId: number, mbid: string, title: string): LidarrAlbum => ({
  id,
  title,
  foreignAlbumId: mbid,
  monitored: true,
  artistId,
  releaseDate: '1998-04-20T00:00:00Z',
  albumType: 'Album',
  secondaryTypes: [],
  genres: [],
  duration: 0,
  images: [{ coverType: 'cover', url: `/MediaCover/Albums/${id}/cover.jpg` }],
  statistics: { trackFileCount: 0, trackCount: 11, totalTrackCount: 11, sizeOnDisk: 0, percentOfTracks: 0 },
});
const track = (id: number, albumId: number, rec: string | undefined, n: string, fileId: number): LidarrTrack => ({
  id,
  albumId,
  artistId: 1,
  title: `Song ${id}`,
  trackNumber: n,
  absoluteTrackNumber: Number(n),
  mediumNumber: 1,
  duration: 379_000,
  explicit: false,
  hasFile: fileId > 0,
  trackFileId: fileId,
  foreignRecordingId: rec,
});
const file = (id: number, ext: string): LidarrTrackFile => ({
  id,
  artistId: 1,
  albumId: 10,
  path: `/music/Massive Attack/Mezzanine/${id}.${ext}`,
  size: 1000 + id,
  dateAdded: '2026-10-01T10:00:00Z',
  mediaInfo: { audioCodec: ext === 'flac' ? 'FLAC' : 'MP3', audioBits: '16bit', audioSampleRate: '44.1kHz' },
});

function fakeLidarr() {
  const tracksForArtist = vi.fn(async (id: number) =>
    id === 1
      ? [
          track(100, 10, 'rec-1', '1', 1000),
          track(101, 10, 'rec-2', '2', 1001),
          track(102, 10, undefined, '3', 1002),
          track(103, 11, 'rec-3', '1', 0), // Protection: no file
        ]
      : [],
  );
  const client = {
    artists: async () => [artist(1, 'Massive Attack', 'art-1', 3), artist(2, 'Nobody', 'art-2', 0)],
    albums: async () => [album(10, 1, 'rg-1', 'Mezzanine'), album(11, 1, 'rg-2', 'Protection')],
    tracksForArtist,
    trackFilesForArtist: async (id: number) => (id === 1 ? [file(1000, 'flac'), file(1001, 'mp3'), file(1002, 'flac')] : []),
  } as unknown as LidarrClient;
  return { client, tracksForArtist };
}

describe('LidarrSource', () => {
  it('reports missing songs of albums it has files for', async () => {
    const { client } = fakeLidarr();
    (client as unknown as { tracksForArtist: () => Promise<LidarrTrack[]> }).tracksForArtist = async () => [
      track(100, 10, 'rec-1', '1', 1000),
      track(104, 10, 'rec-4', '4', 0), // Mezzanine, no file
      track(103, 11, 'rec-3', '1', 0), // Protection: no files at all
    ];
    const sync = await new LidarrSource(client).sync();
    expect(sync.metaRank).toBe(0);
    expect(sync.albums.map((a) => a.key)).toEqual(['mb:rg-1']);
    expect(sync.tracks.map((t) => t.recordingId)).toEqual(['rec-1', 'rec-4']);
    expect(sync.copies.map((c) => c.trackKey)).toEqual(['mb:rg-1#rec-1']);
  });

  it('reports artists, albums, songs and files with Lidarr ids as preferred ids', async () => {
    const { client, tracksForArtist } = fakeLidarr();
    const sync = await new LidarrSource(client).sync();

    expect(tracksForArtist).toHaveBeenCalledTimes(1); // artists without files are skipped
    expect(sync.artists).toEqual([
      expect.objectContaining({ key: 'mb:art-1', preferredId: 1, name: 'Massive Attack', imageUrl: '/art/artist/1/poster?v=123' }),
    ]);
    expect(sync.albums).toEqual([
      expect.objectContaining({ key: 'mb:rg-1', preferredId: 10, artistKey: 'mb:art-1', coverUrl: '/art/album/10/cover' }),
    ]);
    expect(sync.tracks.map((t) => [t.key, t.preferredId, t.recordingId])).toEqual([
      ['mb:rg-1#rec-1', 100, 'rec-1'],
      ['mb:rg-1#rec-2', 101, 'rec-2'],
      ['mb:rg-1#track:102', 102, 'track:102'],
    ]);
    expect(sync.tracks[0]).toMatchObject({ duration: 379, trackNumber: 1, discNumber: 1 });
    expect(sync.copies[0]).toMatchObject({ ref: '1000', preferredId: 1000, trackKey: 'mb:rg-1#rec-1' });
    expect(sync.copies[0]!.format.lossless).toBe(true);
    expect(sync.lidarrAlbums!.map((a) => a.mbid)).toEqual(['rg-1', 'rg-2']);
  });

  it('keeps every Lidarr id unchanged through the catalog', async () => {
    const store = new CatalogStore(freshDb());
    store.applySync(store.ensureSource('lidarr', 'Lidarr'), await new LidarrSource(fakeLidarr().client).sync());
    const c = buildCatalog(store.load());
    expect(c.albums.get(10)!.tracks[0]).toMatchObject({
      id: 100,
      fileId: 1000,
      albumId: 10,
      artistId: 1,
      streamUrl: '/stream/1000',
      coverUrl: '/art/album/10/cover',
    });
    expect(c.albumsByMbid.get('rg-2')).toEqual({ lidarrId: 11, monitored: true, albumId: undefined });
  });

  it('falls back to the file length for songs MusicBrainz has no length for, asking Lidarr once per file', async () => {
    const { client } = fakeLidarr();
    const untimed = { ...track(101, 10, 'rec-2', '2', 1001), duration: 0 };
    Object.assign(client, {
      tracksForArtist: async () => [track(100, 10, 'rec-1', '1', 1000), untimed],
      trackFile: vi.fn(async (id: number) => ({ ...file(id, 'mp3'), audioTags: { duration: '00:01:18.2666666' } })),
    });
    const source = new LidarrSource(client);

    const sync = await source.sync();
    expect(sync.tracks.map((t) => t.duration)).toEqual([379, 78]);
    expect(client.trackFile).toHaveBeenCalledExactlyOnceWith(1001); // only the song without a length

    await source.sync();
    expect(client.trackFile).toHaveBeenCalledTimes(1);
  });

  it('reads Lidarr time spans', () => {
    expect(timeSpanSeconds('00:01:18.2666666')).toBe(78);
    expect(timeSpanSeconds('00:04:05')).toBe(245);
    expect(timeSpanSeconds('1.02:03:04')).toBe(93_784);
    expect(timeSpanSeconds(undefined)).toBe(0);
    expect(timeSpanSeconds('soon')).toBe(0);
  });

  it('gives a repeated recording on one album its own key', async () => {
    const { client } = fakeLidarr();
    (client as unknown as { tracksForArtist: () => Promise<LidarrTrack[]> }).tracksForArtist = async () => [
      track(100, 10, 'rec-1', '1', 1000),
      track(101, 10, 'rec-1', '2', 1001),
    ];
    const sync = await new LidarrSource(client).sync();
    expect(sync.tracks.map((t) => t.key)).toEqual(['mb:rg-1#rec-1', 'mb:rg-1#rec-1#2']);
  });
});
