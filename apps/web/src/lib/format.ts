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

/** Lossy at this bitrate or more sounds as good as lossy gets: its badge leaves the bitrate out. */
const ORDINARY_KBPS = 256;

/**
 * What a format badge says (docs/design.md, Words): the codec, and the detail only when it's out of the ordinary.
 * "MP3" (256 kbps or more), "MP3 · 128 kbps"; "FLAC" (CD quality), "FLAC · 24/96". `formatDetails` has the rest.
 */
export function formatBadge(f: AudioFormat | undefined): { codec: string; detail?: string } | undefined {
  if (!f) return undefined;
  if (f.lossless) {
    const khz = f.sampleRate ? f.sampleRate / 1000 : undefined;
    // CD quality (16-bit at 44.1 or 48 kHz) is ordinary; more is Hi-Res, less is worth knowing too.
    const ordinary = f.bits === 16 && (f.sampleRate === 44_100 || f.sampleRate === 48_000);
    if (ordinary || !f.bits || !khz) return { codec: f.codec };
    return { codec: f.codec, detail: `${f.bits}/${Number.isInteger(khz) ? khz : khz.toFixed(1)}` };
  }
  return f.bitrate && f.bitrate < ORDINARY_KBPS ? { codec: f.codec, detail: `${Math.round(f.bitrate)} kbps` } : { codec: f.codec };
}

/** A badge's words on one line: "MP3 · 128 kbps", "FLAC". */
export function badgeText(f: AudioFormat | undefined): string | undefined {
  const badge = formatBadge(f);
  return badge && (badge.detail ? `${badge.codec} · ${badge.detail}` : badge.codec);
}

/** Hi-res = more than CD quality (16-bit/44.1kHz). */
export function isHiRes(f: AudioFormat | undefined): boolean {
  return !!f?.lossless && ((f.bits ?? 0) > 16 || (f.sampleRate ?? 0) > 48_000);
}

/** Everything about a format, for a badge's title and Show metadata: "FLAC · 24-bit / 96 kHz · stereo · Hi-Res lossless". */
export function formatDetails(f: AudioFormat): string {
  const parts = [f.codec];
  if (f.bits || f.sampleRate) parts.push([f.bits && `${f.bits}-bit`, f.sampleRate && `${f.sampleRate / 1000} kHz`].filter(Boolean).join(' / '));
  if (f.bitrate) parts.push(`${Math.round(f.bitrate)} kbps`);
  if (f.channels) parts.push(f.channels === 1 ? 'mono' : f.channels === 2 ? 'stereo' : `${f.channels} ch`);
  parts.push(isHiRes(f) ? 'Hi-Res lossless' : f.lossless ? 'lossless' : 'lossy');
  return parts.join(' · ');
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
