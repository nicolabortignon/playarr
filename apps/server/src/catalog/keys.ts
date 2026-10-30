import { albumKey, normalize } from '../library/search.ts';

// MusicBrainz ids when known, so the same music from different sources merges. Name-based keys
// are the fallback for music MusicBrainz doesn't know (folder sources, later phases).

export const artistKeyFor = (mbid: string | undefined, name: string) =>
  mbid ? `mb:${mbid}` : `name:${normalize(name)}`;

export const albumKeyFor = (mbid: string | undefined, artistName: string, title: string) =>
  mbid ? `mb:${mbid}` : `name:${albumKey(artistName, title)}`;

/** A song on an album. Keyed by recording, so editions of an album share their songs. */
export const trackKeyFor = (albumKeyValue: string, recordingId: string) => `${albumKeyValue}#${recordingId}`;
