import type { AudioFormat } from '@playarr/shared';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db.ts';
import type { SourceSync } from './types.ts';

export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export const FLAC: AudioFormat = { codec: 'FLAC', container: 'flac', bits: 16, sampleRate: 44100, lossless: true };
export const FLAC_24: AudioFormat = { codec: 'FLAC', container: 'flac', bits: 24, sampleRate: 96000, lossless: true };
export const MP3: AudioFormat = { codec: 'MP3', container: 'mp3', bitrate: 320, lossless: false };

/** One artist, one album, two songs, each with one FLAC copy; ids as Lidarr would give them. */
export function mezzanine(): SourceSync {
  return {
    artists: [
      { key: 'mb:art-1', preferredId: 7, mbid: 'art-1', name: 'Massive Attack', sortName: 'Massive Attack', genres: ['trip hop'] },
    ],
    albums: [
      {
        key: 'mb:rg-1',
        preferredId: 70,
        artistKey: 'mb:art-1',
        mbid: 'rg-1',
        title: 'Mezzanine',
        albumType: 'Album',
        secondaryTypes: [],
        releaseDate: '1998-04-20T00:00:00Z',
        genres: [],
        totalTrackCount: 11,
      },
    ],
    tracks: [
      { key: 'mb:rg-1#rec-2', preferredId: 701, albumKey: 'mb:rg-1', recordingId: 'rec-2', title: 'Risingson', trackNumber: 2, discNumber: 1, duration: 298, explicit: false },
      { key: 'mb:rg-1#rec-1', preferredId: 700, albumKey: 'mb:rg-1', recordingId: 'rec-1', title: 'Angel', trackNumber: 1, discNumber: 1, duration: 379, explicit: false },
    ],
    copies: [
      { ref: '9000', preferredId: 9000, trackKey: 'mb:rg-1#rec-1', path: '/music/Massive Attack/Mezzanine/01.flac', size: 40_000_000, format: FLAC, addedAt: '2026-10-01T10:00:00Z' },
      { ref: '9001', preferredId: 9001, trackKey: 'mb:rg-1#rec-2', path: '/music/Massive Attack/Mezzanine/02.flac', size: 30_000_000, format: FLAC, addedAt: '2026-10-02T10:00:00Z' },
    ],
    lidarrAlbums: [
      { mbid: 'rg-1', lidarrId: 70, monitored: true },
      { mbid: 'rg-2', lidarrId: 71, monitored: true },
    ],
  };
}
