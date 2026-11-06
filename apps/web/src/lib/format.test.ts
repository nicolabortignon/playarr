import { describe, expect, it } from 'vitest';
import type { AudioFormat } from '@playarr/shared';
import { badgeText, formatDetails, releaseKind } from './format';

describe('releaseKind', () => {
  it('names a release by its primary type, qualified or replaced by its first secondary type', () => {
    expect(releaseKind('Album')).toBe('Album');
    expect(releaseKind('EP', [])).toBe('EP');
    expect(releaseKind('Album', ['Live'])).toBe('Live album');
    expect(releaseKind('EP', ['Live'])).toBe('Live EP');
    expect(releaseKind('Album', ['Compilation', 'Live'])).toBe('Compilation');
    expect(releaseKind('Album', ['DJ-mix'])).toBe('DJ mix');
    expect(releaseKind('Album', ['Mixtape/Street'])).toBe('Mixtape');
  });

  it('says something readable for Playarr’s loose songs and types it doesn’t know', () => {
    expect(releaseKind('Loose')).toBe('Loose songs');
    expect(releaseKind('Other')).toBe('Release');
    expect(releaseKind('')).toBe('Album');
    expect(releaseKind('Album', ['bonus'])).toBe('Bonus');
  });
});

const mp3 = (bitrate: number): AudioFormat => ({ codec: 'MP3', container: 'mp3', bitrate, channels: 2, lossless: false });
const flac = (bits: number, sampleRate: number): AudioFormat => ({ codec: 'FLAC', container: 'flac', bits, sampleRate, channels: 2, lossless: true });

describe('badgeText', () => {
  it('names the codec alone when the format is ordinary', () => {
    expect(badgeText(mp3(320))).toBe('MP3');
    expect(badgeText(mp3(256))).toBe('MP3');
    expect(badgeText(flac(16, 44_100))).toBe('FLAC');
    expect(badgeText({ codec: 'AAC', container: 'm4a', lossless: false })).toBe('AAC');
  });

  it('says what’s out of the ordinary, with its unit', () => {
    expect(badgeText(mp3(8))).toBe('MP3 · 8 kbps');
    expect(badgeText(mp3(128))).toBe('MP3 · 128 kbps');
    expect(badgeText(flac(24, 96_000))).toBe('FLAC · 24/96');
    expect(badgeText(flac(24, 88_200))).toBe('FLAC · 24/88.2');
    expect(badgeText(flac(8, 22_050))).toBe('FLAC · 8/22.1');
  });
});

describe('formatDetails', () => {
  it('gives everything a badge leaves out', () => {
    expect(formatDetails(flac(24, 96_000))).toBe('FLAC · 24-bit / 96 kHz · stereo · Hi-Res lossless');
    expect(formatDetails(flac(16, 44_100))).toBe('FLAC · 16-bit / 44.1 kHz · stereo · lossless');
    expect(formatDetails(mp3(320))).toBe('MP3 · 320 kbps · stereo · lossy');
  });
});
