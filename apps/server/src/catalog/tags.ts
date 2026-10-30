import type { AudioFormat } from '@playarr/shared';
import { parseFile } from 'music-metadata';
import { extname } from 'node:path';

/** What a folder file says about itself. Stored as JSON in folder_files. */
export interface TagInfo {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  year?: number;
  genres: string[];
  duration: number; // seconds
  recordingMbid?: string;
  releaseGroupMbid?: string;
  artistMbid?: string;
  albumArtistMbid?: string;
  format: AudioFormat;
}

const LOSSLESS = new Set(['FLAC', 'ALAC', 'PCM', 'WAV', 'AIFF', 'WAVPACK']);

/** Tags and format of an audio file; null if it isn't readable audio. */
export async function readTags(path: string): Promise<TagInfo | null> {
  const { format: f, common: c } = await parseFile(path, { skipCovers: true });
  if (!f.codec && !f.duration) return null;
  const container = extname(path).slice(1).toLowerCase();
  const codec = codecName(f.codec, container);
  const tags: TagInfo = {
    title: c.title || undefined,
    artist: c.artist || undefined,
    albumArtist: c.albumartist || undefined,
    album: c.album || undefined,
    trackNumber: c.track.no ?? undefined,
    trackTotal: c.track.of ?? undefined,
    discNumber: c.disk.no ?? undefined,
    year: c.year || undefined,
    genres: c.genre ?? [],
    duration: Math.round(f.duration ?? 0),
    recordingMbid: c.musicbrainz_recordingid || undefined,
    releaseGroupMbid: c.musicbrainz_releasegroupid || undefined,
    artistMbid: c.musicbrainz_artistid?.[0] || undefined,
    albumArtistMbid: c.musicbrainz_albumartistid?.[0] || undefined,
    format: {
      codec,
      container,
      bits: f.bitsPerSample || undefined,
      sampleRate: f.sampleRate || undefined,
      bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : undefined,
      channels: f.numberOfChannels || undefined,
      lossless: f.lossless ?? LOSSLESS.has(codec),
    },
  };
  // Drop undefined fields so the stored JSON (and test expectations) stay small.
  return JSON.parse(JSON.stringify(tags)) as TagInfo;
}

/** music-metadata says "MPEG 1 Layer 3"; the app's format badges expect "MP3". */
function codecName(codec: string | undefined, container: string): string {
  const c = (codec ?? '').toLowerCase();
  if (c.includes('layer 3')) return 'MP3';
  if (c.includes('flac')) return 'FLAC';
  if (c.includes('alac')) return 'ALAC';
  if (c.includes('aac') || c.includes('mp4a')) return 'AAC';
  if (c.includes('opus')) return 'OPUS';
  if (c.includes('vorbis')) return 'VORBIS';
  if (c.includes('pcm')) return 'PCM';
  return (codec || container).toUpperCase();
}
