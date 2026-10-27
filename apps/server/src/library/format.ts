import type { AudioFormat } from '@playarr/shared';
import type { LidarrTrackFile } from '../lidarr/types.ts';

const LOSSLESS_CODECS = new Set(['FLAC', 'ALAC', 'WAV', 'PCM', 'AIFF', 'APE', 'WAVPACK', 'WV']);

export function formatFromTrackFile(file: LidarrTrackFile): AudioFormat {
  const info = file.mediaInfo ?? {};
  const container = file.path.split('.').pop()?.toLowerCase() ?? '';
  const codec = (info.audioCodec || container).toUpperCase();
  const bits = Number.parseInt(info.audioBits ?? '', 10);
  const kbps = Number.parseInt(info.audioBitRate ?? '', 10);
  const khz = Number.parseFloat(info.audioSampleRate ?? '');
  return {
    codec,
    container,
    bits: Number.isFinite(bits) ? bits : undefined,
    sampleRate: Number.isFinite(khz) ? Math.round(khz * 1000) : undefined,
    bitrate: Number.isFinite(kbps) ? kbps : undefined,
    channels: info.audioChannels,
    lossless: LOSSLESS_CODECS.has(codec),
  };
}

export function formatKey(f: AudioFormat): string {
  return `${f.codec}|${f.bits ?? ''}|${f.sampleRate ?? ''}`;
}

const MIME_BY_EXT: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  webm: 'audio/webm',
};

export function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
