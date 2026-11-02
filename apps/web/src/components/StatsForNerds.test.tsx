import type { MixMap, TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useToasts } from '../lib/toast';
import { useLevels } from '../player/levels';
import { useClock, usePlayer } from '../player/store';
import { useTransition } from '../player/transitions';
import { gridPosition, keyName, sectionAt, StatsForNerds } from './StatsForNerds';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const track = (id: number) =>
  ({
    id,
    recordingId: `rec-${id}`,
    fileId: id,
    albumId: id,
    artistId: id,
    title: `Song ${id}`,
    artistName: `Artist ${id}`,
    albumTitle: 'A',
    duration: 240,
    streamUrl: `/stream/${id}`,
    format: { codec: 'FLAC', container: 'flac', lossless: true, bits: 16, sampleRate: 44100, channels: 2 },
  }) as Track;

// 120 BPM: a beat every half second, bars every 2 s, phrases every 8 s, from the first beat at 1 s.
const MAP: MixMap = {
  version: 7,
  duration: 240,
  bpm: 120,
  firstBeat: 1,
  downbeatOffset: 0,
  gridStable: true,
  beatConfidence: 0.9,
  key: { camelot: '8A', confidence: 0.8 },
  introEnd: 17,
  outroStart: 200,
  firstDrop: 33,
  coldStart: false,
  coldEnd: true,
  soundStart: 0.2,
  soundEnd: 239,
  beatsFrom: 'model',
  phraseEnergy: Array.from({ length: 29 }, (_, k) => 0.3 + (k % 5) / 10),
  // Phrase 5 (where the song is at 34.6 s) strays; so do two others.
  phraseDrift: Array.from({ length: 30 }, (_, k) => (k === 4 ? 34 : k === 9 ? -60 : k === 20 ? null : k === 25 ? 30 : 3)),
  edgesStable: true,
};

const plan: TransitionPlan = {
  style: 'long',
  beats: 32,
  aStart: 200,
  length: 16,
  bStart: 8,
  bResume: 24,
  switchAt: 8,
  bRate: [
    { at: 0, value: 0.98 },
    { at: 16, value: 1 },
  ],
  aGain: [],
  bGain: [],
  aLowDb: [],
  bLowDb: [],
  aHighPassHz: [],
  reason: 'Both songs hold a steady beat, so they blend over a phrase.',
};

const view = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StatsForNerds />
    </QueryClientProvider>,
  );

/** The value next to a label (the first such row) comes to read `value`. */
const expectRow = (label: string, value: string) =>
  waitFor(() => expect(screen.getAllByText(label, { selector: 'dt' })[0]!.nextElementSibling!.textContent).toBe(value));

beforeEach(() => {
  usePrefs.setState({ statsForNerds: true, transitions: 'dj', levelVolume: true });
  usePlayer.setState({ queue: [1, 2].map(track), order: [0, 1], pos: 0, repeat: 'off', mixMode: 'auto', playing: false });
  useClock.setState({ time: 34.6, duration: 240, buffered: 64.6, loading: false, error: null });
  useLevels.setState({ levels: { 'rec-1': { track: -5, album: -6, lufs: -9, peak: -0.3 } }, loaded: { 1: -6 } });
  useTransition.setState({ fromFileId: 1, toFileId: 2, result: { status: 'ready', plan, url: '/t/1', levels: { a: -6, b: -2 } }, ready: undefined });
  vi.spyOn(api, 'mixMaps').mockResolvedValue({ 'rec-1': MAP });
  vi.spyOn(api, 'trackMetadata').mockResolvedValue({
    copies: [],
    genres: ['trip hop'],
    analysis: { loudness: 0.6, dynamics: 0.2, brightness: 0.4, busyness: 0.3, bass: 0.55 },
  } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the beat grid', () => {
  it('counts bars, beats and phrases from the first bar', () => {
    expect(gridPosition(MAP, 1)).toEqual({ bar: 1, beat: 1, phrase: 1, barOfPhrase: 1 });
    expect(gridPosition(MAP, 2.6)).toEqual({ bar: 1, beat: 4, phrase: 1, barOfPhrase: 1 });
    expect(gridPosition(MAP, 34.6)).toEqual({ bar: 17, beat: 4, phrase: 5, barOfPhrase: 1 });
    expect(gridPosition(MAP, 43)).toEqual({ bar: 22, beat: 1, phrase: 6, barOfPhrase: 2 });
    expect(gridPosition({ ...MAP, downbeatOffset: 2 }, 1.5)).toBeNull(); // a pickup beat before the first bar
    expect(gridPosition(MAP, 0.5)).toBeNull();
    expect(gridPosition({ ...MAP, bpm: 0 }, 30)).toBeNull();
  });

  it('names the part of the song', () => {
    expect(sectionAt(MAP, 0.1)).toBe('silence');
    expect(sectionAt(MAP, 5)).toBe('intro');
    expect(sectionAt(MAP, 20)).toBe('main');
    expect(sectionAt(MAP, 40)).toBe('main, past the drop');
    expect(sectionAt(MAP, 210)).toBe('outro');
  });

  it('names keys from their Camelot codes', () => {
    expect(keyName('8A')).toBe('A minor');
    expect(keyName('8B')).toBe('C major');
    expect(keyName('1A')).toBe('G♯ minor');
    expect(keyName('12B')).toBe('E major');
  });
});

describe('Stats for nerds', () => {
  it('stays hidden until it’s turned on, and with nothing playing', () => {
    usePrefs.setState({ statsForNerds: false });
    view();
    expect(screen.queryByRole('complementary', { name: 'Stats for nerds' })).toBeNull();
    cleanup();
    usePrefs.setState({ statsForNerds: true });
    usePlayer.setState({ queue: [], order: [], pos: -1 });
    view();
    expect(screen.queryByRole('complementary', { name: 'Stats for nerds' })).toBeNull();
  });

  it('shows the song’s tempo, key, place on the grid and structure', async () => {
    view();
    await expectRow('Tempo', '120.00 BPM · 500 ms a beat');
    await expectRow('Key', '8A · A minor · 80% sure');
    await expectRow('Now', 'bar 17.4 · phrase 5 (bar 1/4)');
    await expectRow('Beat', '90% sure · steady · holds where mixed · beat model');
    await expectRow('Drift', '+34 ms, drifts · 3 of 30 phrases drift');
    await expectRow('Section', 'main, past the drop');
    await expectRow('Intro', 'to 0:17.0 · eases in');
    await expectRow('Outro', 'from 3:20.0 · cold end');
    await expectRow('First drop', '0:33.0');
    // The phrase strip spans the whole song (30 phrases of 8 s from the first bar at 1 s), with lines at the intro's end and the outro's start.
    await expectRow('Phrases', '0.70intro ends 0:17.0outro from 3:20.0');
    const marker = (which: string) => document.querySelector<HTMLElement>(`[data-marker="${which}"]`)!.style.left;
    expect(parseFloat(marker('intro'))).toBeCloseTo((16 / 240) * 100, 3);
    expect(parseFloat(marker('outro'))).toBeCloseTo((199 / 240) * 100, 3);
  });

  it('shows the loudness measured and the gain the stream plays at', async () => {
    view();
    await expectRow('Measured', '−9.0 LUFS · peak −0.3 dBFS');
    await expectRow('Gains', 'track −5.0 dB · album −6.0 dB');
    await expectRow('Applied', '−6.0 dB in the stream (album gain)');
    await expectRow('Heard at', '≈ −15.0 LUFS');
    await expectRow('Stream', 'levelled WAV at −6.0 dB');
  });

  it('shows the playback, the file and the sound', async () => {
    view();
    await expectRow('Position', '0:34.6 / 4:00.0 · paused');
    await expectRow('Buffer', '30.0 s ahead');
    await expectRow('Format', 'FLAC · 16-bit / 44.1 kHz · stereo · lossless');
    await expectRow('Texture', 'bright 0.40 · busy 0.30 · bass 0.55');
    await expectRow('Genres', 'trip hop');
  });

  it('shows the next transition', async () => {
    view();
    await expectRow('Mix', 'ready · long, 32 beats');
    await expectRow('Mix at', '3:20.0 (in 2:45) → 0:08.0 of the next');
    await expectRow('Next’s rate', '×0.980 – ×1.000');
    await expectRow('Levels', '−6.0 dB → −2.0 dB');
    await expectRow('Why', plan.reason);
  });

  it('leaves out the next song’s rate when it plays at its own tempo', async () => {
    const steady = { ...plan, bRate: [{ at: 0, value: 0.99998 }, { at: 16, value: 1 }] };
    useTransition.setState({ result: { status: 'pending', plan: steady } });
    view();
    await expectRow('Mix', 'being made · long, 32 beats');
    expect(screen.queryByText('Next’s rate')).toBeNull();
  });

  it('says what isn’t known yet', async () => {
    useLevels.setState({ levels: {}, loaded: {} });
    vi.mocked(api.mixMaps).mockResolvedValue({});
    view();
    await expectRow('Tempo', 'not analysed yet');
    await expectRow('Measured', 'not measured yet');
    await expectRow('Stream', 'its own file');
  });

  it('collapses to one line, and turns off with an undo', async () => {
    view();
    await screen.findByText('120.00 BPM · 500 ms a beat');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByText('Tempo')).toBeNull();
    expect(screen.getByText('120.0 BPM · 8A · 17.4 · −9.0 LUFS')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off stats for nerds' }));
    expect(usePrefs.getState().statsForNerds).toBe(false);
    expect(screen.queryByRole('complementary', { name: 'Stats for nerds' })).toBeNull();
    useToasts.getState().toasts.at(-1)!.action!.run();
    expect(usePrefs.getState().statsForNerds).toBe(true);
  });
});
