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
  /** Edition details for the review list (absent on releases cached before they were fetched). */
  country?: string;
  status?: string;
  disambiguation?: string;
  barcode?: string;
  labels?: { name?: string; catalogNumber?: string }[];
  /** One per medium: "CD", "Digital Media", "12\" Vinyl"… */
  formats?: string[];
  /** Fetched with the edition details above. */
  detailed?: true;
}

/** /ws/2/release/:id?inc=recordings+artist-credits+release-groups (only the fields used). */
export interface MbReleaseRaw {
  id: string;
  title: string;
  date?: string;
  country?: string | null;
  status?: string | null;
  disambiguation?: string | null;
  barcode?: string | null;
  'label-info'?: { 'catalog-number'?: string | null; label?: { name: string } | null }[];
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
    format?: string | null;
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
    ...(raw.country ? { country: raw.country } : {}),
    ...(raw.status ? { status: raw.status } : {}),
    ...(raw.disambiguation ? { disambiguation: raw.disambiguation } : {}),
    ...(raw.barcode ? { barcode: raw.barcode } : {}),
    labels: (raw['label-info'] ?? [])
      .map((l) => ({ ...(l.label?.name ? { name: l.label.name } : {}), ...(l['catalog-number'] ? { catalogNumber: l['catalog-number'] } : {}) }))
      .filter((l) => l.name || l.catalogNumber),
    formats: raw.media.map((m) => m.format || 'Unknown format'),
    detailed: true,
  };
}

/** "2×CD", "CD + DVD", "Digital Media": the media of a release, counted. */
export function formatSummary(formats: string[] | undefined): string | undefined {
  if (!formats?.length) return undefined;
  const counts = new Map<string, number>();
  for (const f of formats) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts].map(([f, n]) => (n > 1 ? `${n}×${f}` : f)).join(' + ');
}
