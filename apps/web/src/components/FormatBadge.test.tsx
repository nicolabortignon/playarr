import type { AudioFormat } from '@playarr/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormatBadge } from './FormatBadge';

afterEach(cleanup);

const mp3 = (bitrate: number): AudioFormat => ({ codec: 'MP3', container: 'mp3', bitrate, channels: 2, lossless: false });
const flac = (bits: number, sampleRate: number): AudioFormat => ({ codec: 'FLAC', container: 'flac', bits, sampleRate, channels: 2, lossless: true });

/** What the badge says, and what its title adds. */
function badge(format: AudioFormat) {
  const el = render(<FormatBadge format={format} />).container.firstElementChild as HTMLElement;
  return { text: el.textContent, title: el.title };
}

describe('FormatBadge', () => {
  it('says only what’s worth saying, the rest in its title', () => {
    expect(badge(mp3(320))).toEqual({ text: 'MP3', title: 'MP3 · 320 kbps · stereo · lossy' });
    expect(badge(mp3(8))).toEqual({ text: 'MP3 · 8 kbps', title: 'MP3 · 8 kbps · stereo · lossy' });
    expect(badge(flac(16, 44_100))).toEqual({ text: 'FLAC', title: 'FLAC · 16-bit / 44.1 kHz · stereo · lossless' });
    expect(badge(flac(24, 96_000))).toEqual({ text: 'FLAC · 24/96', title: 'FLAC · 24-bit / 96 kHz · stereo · Hi-Res lossless' });
  });

  it('keeps a unit’s letters as written, not in the badge’s capitals', () => {
    const { container } = render(<FormatBadge format={mp3(8)} />);
    expect(container.querySelector('.normal-case')?.textContent).toBe('8 kbps');
  });
});
