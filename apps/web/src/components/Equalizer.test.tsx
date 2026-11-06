import type { MixMapEntry } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { BAR_REST, barHeights, setPulseSource, songBeat, useMetered } from '../player/pulse';
import { usePlayer } from '../player/store';
import { Equalizer } from './Equalizer';

const track = { id: 1, recordingId: 'rec-1', fileId: 1, title: 'Teardrop', duration: 330 } as Track;
/** 120 BPM from its first downbeat at 1 s: a beat every half second. */
const analyzed = { bpm: 120, firstBeat: 0.5, downbeatOffset: 1, gridStable: true, beatConfidence: 0.9, phraseEnergy: [] } as unknown as MixMapEntry;
const beat = songBeat(analyzed)!;

/** A stand-in analyzer at 48 kHz: loud bass and middle, no treble. */
const analyzer = {
  fftSize: 1024,
  frequencyBinCount: 512,
  context: { sampleRate: 48_000 },
  getByteFrequencyData: (into: Uint8Array) => {
    into.fill(0);
    into.fill(230, 1, 43);
  },
} as unknown as AnalyserNode;

/** Where the engine says the song is (seconds). */
let songTime = 3.04;

function view(playing = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (on: boolean) => (
    <QueryClientProvider client={client}>
      <Equalizer playing={on} />
    </QueryClientProvider>
  );
  const { rerender } = render(tree(playing));
  return { setPlaying: (on: boolean) => rerender(tree(on)) };
}

const bars = () => [...document.querySelectorAll<HTMLElement>('[data-eq] > span')];
const scales = () => bars().map((b) => Number(/scaleY\(([\d.]+)\)/.exec(b.style.transform)?.[1]));

beforeEach(() => {
  songTime = 3.04;
  vi.spyOn(api, 'mixMaps').mockResolvedValue({ 'rec-1': analyzed });
  usePrefs.setState({ motion: 'full' });
  usePlayer.setState({ queue: [track], order: [0], pos: 0, playing: true });
  useMetered.setState({ metered: true });
  setPulseSource({ songTime: () => songTime, meter: () => analyzer, blend: () => null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setPulseSource(null);
  useMetered.setState({ metered: false });
});

describe('the now-playing bars', () => {
  it('follow what’s heard where the player runs through Web Audio and the song has a beat, landing on it', async () => {
    view();
    await waitFor(() => expect(document.querySelector('[data-eq]')!.getAttribute('data-eq')).toBe('live'));
    // Just after the beat at 3 s: each bar its part of the music (the treble silent), all up with the beat.
    const onBeat = barHeights(beat, 3.04, [1, 1, 0]);
    await waitFor(() => scales().forEach((s, i) => expect(s).toBeCloseTo(onBeat[i]!, 3)));
    expect(onBeat[0]).toBeGreaterThan(0.95);
    expect(onBeat[2]).toBe(BAR_REST);
    // Just before the next beat they've fallen away.
    songTime = 3.45;
    const late = barHeights(beat, 3.45, [1, 1, 0]);
    await waitFor(() => scales().forEach((s, i) => expect(s).toBeCloseTo(late[i]!, 3)));
    expect(late[0]).toBeLessThan(onBeat[0]! - 0.3);
    // Nothing loops meanwhile.
    expect(bars().every((b) => !b.style.animation)).toBe(true);
  });

  it('settle when the music stops', async () => {
    const { setPlaying } = view();
    await waitFor(() => expect(scales()[0]).toBeGreaterThan(0.9));
    setPlaying(false);
    expect(document.querySelector('[data-eq]')!.getAttribute('data-eq')).toBe('live');
    expect(scales()).toEqual([BAR_REST, BAR_REST, BAR_REST]);
    // And stay there: nothing moves them while the music is stopped.
    songTime = 3.04;
    await new Promise((r) => setTimeout(r, 20));
    expect(scales()).toEqual([BAR_REST, BAR_REST, BAR_REST]);
  });

  it('keep their loop for a song without a beat grid', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': { ...analyzed, gridStable: false } });
    view();
    await waitFor(() => expect(api.mixMaps).toHaveBeenCalledWith(['rec-1']));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-eq]')!.getAttribute('data-eq')).toBe('loop');
    expect(bars()[0]!.style.animation).toContain('eq');
  });

  it('keep their loop where the player doesn’t run through Web Audio (phones), without asking for the song’s beat', async () => {
    useMetered.setState({ metered: false });
    view();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-eq]')!.getAttribute('data-eq')).toBe('loop');
    expect(api.mixMaps).not.toHaveBeenCalled();
  });

  it('freeze their loop while paused', () => {
    useMetered.setState({ metered: false });
    view(false);
    expect(bars().every((b) => b.style.animationPlayState === 'paused')).toBe(true);
  });

  it('stand still under Reduce Motion: no loop, nothing following the music', async () => {
    usePrefs.setState({ motion: 'reduce' });
    const read = vi.fn(() => songTime);
    setPulseSource({ songTime: read, meter: () => analyzer, blend: () => null });
    view();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('[data-eq]')!.getAttribute('data-eq')).toBe('still');
    expect(bars().every((b) => !b.style.animation && !b.style.transform)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
