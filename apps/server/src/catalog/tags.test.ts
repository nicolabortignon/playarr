import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMediaSource } from '../media/local.ts';
import { readTags, readTagsFrom } from './tags.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function file(name: string, bytes: Buffer) {
  const t = tempDir();
  cleanup = t.cleanup;
  const path = join(t.dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('readTags', () => {
  it('reads tags, MusicBrainz ids and the audio format', async () => {
    const path = file(
      '01.flac',
      flacBytes({
        TITLE: 'Angel',
        ARTIST: 'Massive Attack',
        ALBUMARTIST: 'Massive Attack',
        ALBUM: 'Mezzanine',
        TRACKNUMBER: '1',
        TRACKTOTAL: '11',
        DISCNUMBER: '1',
        DATE: '1998',
        GENRE: 'Trip Hop',
        MUSICBRAINZ_TRACKID: 'rec-1',
        MUSICBRAINZ_RELEASEGROUPID: 'rg-1',
        MUSICBRAINZ_ALBUMARTISTID: 'art-1',
      }),
    );
    expect(await readTags(path)).toEqual({
      title: 'Angel',
      artist: 'Massive Attack',
      albumArtist: 'Massive Attack',
      album: 'Mezzanine',
      trackNumber: 1,
      trackTotal: 11,
      discNumber: 1,
      year: 1998,
      genres: ['Trip Hop'],
      duration: 200,
      recordingMbid: 'rec-1',
      releaseGroupMbid: 'rg-1',
      albumArtistMbid: 'art-1',
      format: { codec: 'FLAC', container: 'flac', bits: 16, sampleRate: 44100, channels: 2, lossless: true },
    });
  });

  it('reads a file without tags', async () => {
    const tags = await readTags(file('x.flac', flacBytes()));
    expect(tags).toMatchObject({ genres: [], duration: 200, format: { codec: 'FLAC' } });
    expect(tags!.title).toBeUndefined();
  });

  it('returns null for a file that is not audio', async () => {
    expect(await readTags(file('broken.mp3', Buffer.from('not audio at all')))).toBeNull();
  });

  it('reads tags from byte ranges through any media source', async () => {
    const path = file('01.flac', flacBytes({ TITLE: 'Angel', MUSICBRAINZ_TRACKID: 'rec-1' }));
    const media = new LocalMediaSource();
    const open = vi.spyOn(media, 'open');
    const tags = await readTagsFrom(media, path, statSync(path).size);
    expect(tags).toMatchObject({ title: 'Angel', recordingMbid: 'rec-1', duration: 200, format: { codec: 'FLAC', container: 'flac' } });
    expect(open.mock.calls.every(([, range]) => range !== undefined)).toBe(true);
  });
});
