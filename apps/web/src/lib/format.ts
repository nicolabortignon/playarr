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

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
