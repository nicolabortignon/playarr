import type { AudioFormat } from '@playarr/shared';
import { tokenizer as rangeTokenizer, type IRangeRequestClient } from '@tokenizer/range';
import { parseFile, parseFromTokenizer, type IAudioMetadata } from 'music-metadata';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { mimeForPath } from '../library/format.ts';
import type { MediaSource } from '../media/index.ts';
import { readAlacInfo, type ReadBytes } from './mp4.ts';

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
  Pick<
    TagInfo,
    'title' | 'album' | 'albumArtist' | 'albumArtistMbid' | 'trackNumber' | 'discNumber' | 'trackTotal' | 'year' | 'recordingMbid' | 'releaseGroupMbid' | 'releaseId'
  >
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
  const tags = toTagInfo(await parseFile(path, { skipCovers: true }), path);
  if (tags?.format.codec !== 'ALAC') return tags;
  const file = await open(path);
  try {
    const read: ReadBytes = async (start, end) => {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(end - start + 1), 0, end - start + 1, start);
      return buffer.subarray(0, bytesRead);
    };
    return await withAlacFormat(tags, read, (await file.stat()).size);
  } finally {
    await file.close();
  }
}

/** An Apple Lossless file's rate, depth and channels from its own config, over music-metadata's (see mp4.ts). */
async function withAlacFormat(tags: TagInfo, read: ReadBytes, size: number): Promise<TagInfo> {
  const alac = await readAlacInfo(read, size).catch(() => null);
  return alac ? { ...tags, format: { ...tags.format, sampleRate: alac.sampleRate, bits: alac.bits, channels: alac.channels } } : tags;
}

/** A range-request client over a MediaSource, so music-metadata can read any part of a remote file. */
function rangeClient(media: MediaSource, path: string, size: number): IRangeRequestClient {
  const info = { size, mimeType: mimeForPath(path), path, acceptPartialRequests: true };
  return {
    getHeadInfo: async () => info,
    async getResponse(_method, range) {
      const start = range?.[0] ?? 0;
      const data = await rangeReader(media, path)(start, Math.min(range?.[1] ?? size - 1, size - 1));
      return {
        ...info,
        contentRange: { firstBytePosition: start, lastBytePosition: start + data.length - 1, instanceLength: size },
        arrayBuffer: async () => new Uint8Array(data),
      };
    },
    abort() {},
  };
}

/** Byte ranges of a file through a MediaSource. */
function rangeReader(media: MediaSource, path: string): ReadBytes {
  return async (start, end) => {
    const chunks: Buffer[] = [];
    for await (const chunk of await media.open(path, { start, end })) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
}

async function parseRemote(media: MediaSource, path: string, size: number, skipCovers: boolean): Promise<IAudioMetadata> {
  const tok = await rangeTokenizer(rangeClient(media, path, size), { minimumChunkSize: 64 * 1024 });
  return parseFromTokenizer(tok, { skipCovers, duration: false });
}

/** Tags of a file read through byte ranges (SSH, SFTP). */
export async function readTagsFrom(media: MediaSource, path: string, size: number): Promise<TagInfo | null> {
  const tags = toTagInfo(await parseRemote(media, path, size, true), path);
  return tags?.format.codec === 'ALAC' ? withAlacFormat(tags, rangeReader(media, path), size) : tags;
}

/**
 * How long a file is to the sample, and its sample rate, channels and bit depth, from its header (an MP4's sample
 * tables, an AIFF's frame count): what a WAV of it holds. The library keeps durations to the second only.
 */
export async function pcmLengthFrom(
  media: MediaSource,
  path: string,
  size: number,
): Promise<{ frames: number; sampleRate: number; channels: number; bits: number } | null> {
  const { format: f } = await parseRemote(media, path, size, true);
  if (codecName(f.codec, '') === 'ALAC') return readAlacInfo(rangeReader(media, path), size);
  if (!f.duration || !f.sampleRate) return null;
  return { frames: Math.round(f.duration * f.sampleRate), sampleRate: f.sampleRate, channels: f.numberOfChannels ?? 2, bits: f.bitsPerSample ?? 16 };
}

/** Lyrics kept in a file's tags: timed lines (milliseconds) or the text, which may itself be LRC. */
export async function lyricsFrom(media: MediaSource, path: string, size: number): Promise<{ synced?: { ms: number; text: string }[]; text?: string } | null> {
  const tag = (await parseRemote(media, path, size, true)).common.lyrics?.find((l) => l.syncText?.length || l.text?.trim());
  if (!tag) return null;
  // ID3 timestamps in milliseconds (format 2); MPEG frames (1) can't be placed without decoding.
  const synced = tag.timeStampFormat === 2 ? tag.syncText.filter((l) => l.timestamp !== undefined) : [];
  if (synced.length) return { synced: synced.map((l) => ({ ms: l.timestamp!, text: l.text })) };
  return tag.text?.trim() ? { text: tag.text } : null;
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
