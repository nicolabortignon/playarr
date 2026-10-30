import type { AudioFormat } from '@playarr/shared';
import { tokenizer as rangeTokenizer, type IRangeRequestClient } from '@tokenizer/range';
import { parseFile, parseFromTokenizer, type IAudioMetadata } from 'music-metadata';
import { extname } from 'node:path';
import { mimeForPath } from '../library/format.ts';
import type { MediaSource } from '../media/index.ts';

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
  /** The MusicBrainz release (edition) a match chose; its track list gives the album's missing songs. */
  releaseId?: string;
  artistMbid?: string;
  albumArtistMbid?: string;
  format: AudioFormat;
}

/** What a match lays over a file's own tags. */
export type MatchOverlay = Partial<
  Pick<TagInfo, 'title' | 'album' | 'albumArtist' | 'albumArtistMbid' | 'trackNumber' | 'discNumber' | 'year' | 'recordingMbid' | 'releaseGroupMbid' | 'releaseId'>
>;

export type MatchState = 'auto' | 'manual' | 'review' | 'unmatched' | 'ignored';

export interface MatchRecord {
  rel: string;
  groupKey: string;
  state: MatchState;
  overlay?: MatchOverlay;
  /** Review: candidate release ids, best first. */
  candidates?: string[];
  score?: number;
  /** The file version this was decided for. */
  size: number;
  mtimeMs: number;
}

const LOSSLESS = new Set(['FLAC', 'ALAC', 'PCM', 'WAV', 'AIFF', 'WAVPACK']);

/** Tags and format of an audio file; null if it isn't readable audio. */
export async function readTags(path: string): Promise<TagInfo | null> {
  return toTagInfo(await parseFile(path, { skipCovers: true }), path);
}

/** A range-request client over a MediaSource, so music-metadata can read any part of a remote file. */
function rangeClient(media: MediaSource, path: string, size: number): IRangeRequestClient {
  const info = { size, mimeType: mimeForPath(path), path, acceptPartialRequests: true };
  return {
    getHeadInfo: async () => info,
    async getResponse(_method, range) {
      const start = range?.[0] ?? 0;
      const end = Math.min(range?.[1] ?? size - 1, size - 1);
      const chunks: Buffer[] = [];
      for await (const chunk of await media.open(path, { start, end })) chunks.push(chunk as Buffer);
      const data = Buffer.concat(chunks);
      return {
        ...info,
        contentRange: { firstBytePosition: start, lastBytePosition: start + data.length - 1, instanceLength: size },
        arrayBuffer: async () => new Uint8Array(data),
      };
    },
    abort() {},
  };
}

async function parseRemote(media: MediaSource, path: string, size: number, skipCovers: boolean): Promise<IAudioMetadata> {
  const tok = await rangeTokenizer(rangeClient(media, path, size), { minimumChunkSize: 64 * 1024 });
  return parseFromTokenizer(tok, { skipCovers, duration: false });
}

/** Tags of a file read through byte ranges (SSH, SFTP). */
export async function readTagsFrom(media: MediaSource, path: string, size: number): Promise<TagInfo | null> {
  return toTagInfo(await parseRemote(media, path, size, true), path);
}

/** The embedded picture of a file read through byte ranges. */
export async function pictureFrom(media: MediaSource, path: string, size: number): Promise<{ body: Buffer; mime: string } | null> {
  const picture = (await parseRemote(media, path, size, false)).common.picture?.[0];
  return picture ? { body: Buffer.from(picture.data), mime: picture.format } : null;
}

function toTagInfo(metadata: IAudioMetadata, path: string): TagInfo | null {
  const { format: f, common: c } = metadata;
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
