import { creditName, type MbArtistCredit } from '../discover/musicbrainz.ts';

/** A MusicBrainz release (one edition of an album) with its track list, as matching uses it. */
export interface MbTrack {
  disc: number;
  position: number;
  title: string;
  length: number; // seconds, 0 if unknown
  recordingId: string;
}

export interface MbReleaseInfo {
  id: string;
  title: string;
  date?: string;
  artistName: string;
  artistId?: string;
  releaseGroup: { id: string; title: string; primaryType?: string; secondaryTypes: string[]; firstReleaseDate?: string };
  tracks: MbTrack[];
}

/** /ws/2/release/:id?inc=recordings+artist-credits+release-groups (only the fields used). */
export interface MbReleaseRaw {
  id: string;
  title: string;
  date?: string;
  'artist-credit'?: MbArtistCredit[];
  'release-group': {
    id: string;
    title: string;
    'primary-type'?: string;
    'secondary-types'?: string[] | null;
    'first-release-date'?: string;
  };
  media: {
    position: number;
    tracks: { position: number; title: string; length: number | null; recording: { id: string; title: string; length: number | null } }[];
  }[];
}

export function toReleaseInfo(raw: MbReleaseRaw): MbReleaseInfo {
  const rg = raw['release-group'];
  return {
    id: raw.id,
    title: raw.title,
    date: raw.date || undefined,
    artistName: creditName(raw['artist-credit']),
    artistId: raw['artist-credit']?.[0]?.artist.id,
    releaseGroup: {
      id: rg.id,
      title: rg.title,
      primaryType: rg['primary-type'],
      secondaryTypes: rg['secondary-types'] ?? [],
      firstReleaseDate: rg['first-release-date'] || undefined,
    },
    tracks: raw.media.flatMap((m) =>
      m.tracks.map((t) => ({
        disc: m.position,
        position: t.position,
        title: t.title,
        length: Math.round((t.length ?? t.recording.length ?? 0) / 1000),
        recordingId: t.recording.id,
      })),
    ),
  };
}
