import type { AudioFormat } from '@playarr/shared';

/** 245 → "4:05", 3725 → "1:02:05" */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 2564 → "43 min", 7300 → "2 hr 1 min" */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** FLAC 24/88.2 · MP3 320 */
export function formatBadge(f: AudioFormat | undefined): string | undefined {
  if (!f) return undefined;
  if (f.lossless) {
    const khz = f.sampleRate ? f.sampleRate / 1000 : undefined;
    const spec = f.bits && khz ? ` ${f.bits}/${Number.isInteger(khz) ? khz : khz.toFixed(1)}` : '';
    return `${f.codec}${spec}`;
  }
  return f.bitrate ? `${f.codec} ${f.bitrate}` : f.codec;
}

/** Hi-res = more than CD quality (16-bit/44.1kHz). */
export function isHiRes(f: AudioFormat | undefined): boolean {
  return !!f?.lossless && ((f.bits ?? 0) > 16 || (f.sampleRate ?? 0) > 48_000);
}

/** 356515840 → "340 MB", 1610612736 → "1.5 GB" */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 || Number.isInteger(gb) ? Math.round(gb) : gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** MusicBrainz's secondary types that name what a release is on their own. */
const SECONDARY_KINDS: Record<string, string> = {
  compilation: 'Compilation',
  soundtrack: 'Soundtrack',
  spokenword: 'Spoken word',
  interview: 'Interview',
  audiobook: 'Audiobook',
  'audio drama': 'Audio drama',
  'dj-mix': 'DJ mix',
  'mixtape/street': 'Mixtape',
  'field recording': 'Field recording',
};
const PRIMARY_KINDS: Record<string, string> = { album: 'Album', ep: 'EP', single: 'Single', broadcast: 'Broadcast', other: 'Release', loose: 'Loose songs' };

/**
 * What a release is, from its MusicBrainz types, for a kicker or a card: "Album", "EP", "Live album", "Soundtrack".
 * Live, remix and demo describe the primary type ("Live EP"); the other secondary types replace it.
 */
export function releaseKind(type: string, secondaryTypes: readonly string[] = []): string {
  const primary = PRIMARY_KINDS[type.toLowerCase()] ?? (type || 'Album');
  const secondary = secondaryTypes[0]?.toLowerCase();
  if (!secondary) return primary;
  if (secondary === 'live' || secondary === 'remix' || secondary === 'demo') {
    const noun = primary === 'EP' ? 'EP' : primary === 'Release' || primary === 'Loose songs' ? 'album' : primary.toLowerCase();
    return `${secondary[0]!.toUpperCase()}${secondary.slice(1)} ${noun}`;
  }
  return SECONDARY_KINDS[secondary] ?? `${secondary[0]!.toUpperCase()}${secondary.slice(1)}`;
}

/** A rough wait: "4 s", "2 min". */
export function formatWait(seconds: number): string {
  return seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;
}
