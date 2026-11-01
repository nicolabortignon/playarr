import type { MixMap, TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { usePlayer } from '../player/store';
import { useSleep } from '../player/sleep';
import { useTransition, type UpcomingResult } from '../player/transitions';
import { nextSongClock, overlapOf, TransitionView } from './TransitionView';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 240, streamUrl: `/s/${id}` }) as Track;

const plan = (style: TransitionPlan['style'], beats: number, extra: Partial<TransitionPlan> = {}): TransitionPlan => ({
  style,
  beats,
  aStart: 200,
  length: 16,
  bStart: 8,
  bResume: 24,
  switchAt: 8,
  bRate: [],
  aGain: [],
  bGain: [],
  aLowDb: [],
  bLowDb: [],
  aHighPassHz: [],
  reason: 'Both songs hold a steady beat, so they blend over a phrase.',
  ...extra,
});

const map = (bpm: number, key?: MixMap['key']): MixMap => ({
  version: 1,
  duration: 240,
  bpm,
  firstBeat: 0.5,
  downbeatOffset: 0,
  gridStable: true,
  beatConfidence: 0.9,
  key,
  introEnd: 16,
  outroStart: 200,
  coldStart: false,
  coldEnd: false,
  soundEnd: 239,
  // One value per 16-beat phrase: 240 s at 120 BPM is 30 phrases.
  phraseEnergy: Array.from({ length: 30 }, (_, k) => 0.3 + (k % 5) / 10),
});

const maps = { 'rec-1': map(124, { camelot: '8A', confidence: 0.8 }), 'rec-2': map(126, { camelot: '9A', confidence: 0.7 }) };

function setResult(result: UpcomingResult | null) {
  useTransition.setState({ fromFileId: 1, toFileId: 2, result, ready: undefined });
}

const view = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TransitionView />
    </QueryClientProvider>,
  );

const line = (name: string) => screen.findByRole('button', { name });

beforeEach(() => {
  usePrefs.setState({ transitions: 'dj' });
  useSleep.getState().cancel();
  usePlayer.setState({ queue: [1, 2, 3].map(track), order: [0, 1, 2], pos: 0, repeat: 'off', mixMode: 'auto' });
  setResult({ status: 'ready', plan: plan('long', 32), url: '/t/1' });
  vi.spyOn(api, 'mixMaps').mockResolvedValue(maps);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TransitionView line', () => {
  it('says how the next song comes in, with both tempos and keys', async () => {
    view();
    expect(await line('Next: 32-beat blend, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
    expect(api.mixMaps).toHaveBeenCalledWith(['rec-1', 'rec-2']);
  });

  it('names a quick mix by its length', async () => {
    setResult({ status: 'ready', plan: plan('quick', 8), url: '/t/1' });
    view();
    expect(await line('Next: 8-beat quick mix, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
  });

  it('names a fade and a straight cut', async () => {
    setResult({ status: 'ready', plan: plan('fade', 0), url: '/t/1' });
    const { unmount } = view();
    expect(await line('Next: crossfade, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
    unmount();
    setResult({ status: 'straight', plan: plan('straight', 0) });
    view();
    expect(await line('Next: straight on, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
  });

  it('shows the plan while the mix is still being made', async () => {
    setResult({ status: 'pending', plan: plan('long', 16) });
    view();
    expect(await line('Next: 16-beat blend, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
  });

  it('says straight on when the mix is unavailable or not ready in time (what plays then)', async () => {
    setResult({ status: 'unavailable', reason: 'Not analysed yet' });
    const { unmount } = view();
    expect(await line('Next: straight on, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
    unmount();
    setResult({ status: 'gave up' });
    view();
    expect(await line('Next: straight on, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
  });

  it('leaves out unsure keys and unknown tempos', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map(0, { camelot: '8A', confidence: 0.9 }), 'rec-2': map(126, { camelot: '9A', confidence: 0.2 }) });
    view();
    expect(await line('Next: 32-beat blend')).toBeTruthy();
  });

  it('says so when this queue is not mixed', async () => {
    usePlayer.setState({ mixMode: 'off' });
    useTransition.setState({ fromFileId: null, toFileId: null, result: null });
    view();
    expect(await line('Next: no mixing, 124 to 126 BPM, 8A to 9A')).toBeTruthy();
  });

  it('is hidden unless transitions are DJ mix', () => {
    usePrefs.setState({ transitions: 'crossfade' });
    view();
    expect(screen.queryByRole('button')).toBeNull();
    expect(api.mixMaps).not.toHaveBeenCalled();
  });

  it('shows arrows and dots, and is read out in words', async () => {
    view();
    const button = await line('Next: 32-beat blend, 124 to 126 BPM, 8A to 9A');
    expect(button.textContent).toBe('Next: 32-beat blend · 124 → 126 BPM · 8A → 9A');
  });

  it('is hidden while the transition store works on another pair', () => {
    useTransition.setState({ fromFileId: 1, toFileId: 3 });
    view();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is hidden when the sleep timer stops after this song, mixed or not', () => {
    useSleep.setState({ endOfSong: true });
    usePlayer.setState({ mixMode: 'off' });
    view();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is hidden when no next song is coming', () => {
    usePlayer.setState({ pos: 2 });
    view();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TransitionView sheet', () => {
  async function openSheet() {
    view();
    fireEvent.click(await line('Next: 32-beat blend, 124 to 126 BPM, 8A to 9A'));
    return within(screen.getByRole('dialog', { name: 'Next transition' }));
  }

  it('opens with the style and the reason', async () => {
    const sheet = await openSheet();
    expect(sheet.getByText('32-beat blend')).toBeTruthy();
    expect(sheet.getByText('Both songs hold a steady beat, so they blend over a phrase.')).toBeTruthy();
  });

  it('draws both songs’ energy, with the numbers in a table', async () => {
    const sheet = await openSheet();
    expect(sheet.getByRole('figure', { name: /Energy around the mix/ })).toBeTruthy();
    const table = sheet.getByRole('table', { hidden: true });
    const rows = within(table).getAllByRole('row', { hidden: true });
    // A header, then the phrases of both songs near the mix.
    expect(rows.length).toBeGreaterThan(4);
    expect(within(table).getAllByText('Song 1', { exact: false, ignore: 'caption' }).length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Song 2', { exact: false, ignore: 'caption' }).length).toBeGreaterThan(0);
    // Each song has a phrase inside the mix.
    expect(within(table).getAllByText('Yes').length).toBeGreaterThanOrEqual(2);
  });

  it('gives the server’s reason for no mix in plain words', async () => {
    setResult({ status: 'unavailable', reason: 'No mix map yet for the next song (“Song 2”)' });
    view();
    fireEvent.click(await line('Next: straight on, 124 to 126 BPM, 8A to 9A'));
    const sheet = within(screen.getByRole('dialog', { name: 'Next transition' }));
    expect(sheet.getByText('The next song hasn’t been analysed yet, so the next song follows straight on.')).toBeTruthy();
  });

  it('falls back to a plain reason it doesn’t know', async () => {
    setResult({ status: 'unavailable', reason: 'Something internal broke' });
    view();
    fireEvent.click(await line('Next: straight on, 124 to 126 BPM, 8A to 9A'));
    expect(screen.getByText('There’s no mix for these two songs, so the next song follows straight on.')).toBeTruthy();
  });

  it('changes how this queue is mixed', async () => {
    const sheet = await openSheet();
    const pills = within(sheet.getByRole('radiogroup', { name: 'Mixing for this queue' }));
    expect(pills.getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(pills.getByRole('radio', { name: 'Party' }));
    expect(usePlayer.getState().mixMode).toBe('party');
    fireEvent.click(pills.getByRole('radio', { name: 'No mixing' }));
    expect(usePlayer.getState().mixMode).toBe('off');
  });
});

describe('the energy picture’s clock', () => {
  it('places the next song stretched to the playing song’s tempo during the mix', () => {
    // 32 seconds of the next song play in a 16-second mix: twice as fast, then at its own pace.
    const clock = nextSongClock(plan('long', 32, { length: 16, bStart: 8, bResume: 40 }));
    expect(clock(0)).toBe(-8);
    expect(clock(8)).toBe(0);
    expect(clock(24)).toBe(8);
    expect(clock(40)).toBe(16);
    expect(clock(50)).toBe(26);
  });

  it('shades only while both songs sound, not the next song easing back alone', () => {
    const gain = [
      { at: 0, value: 1 },
      { at: 8, value: 0.5 },
      { at: 12, value: 0 },
    ];
    expect(overlapOf(plan('long', 32, { length: 24, aGain: gain }), 124)).toBe(12);
    // Without the gain, the plan's beats at the playing song's tempo: 32 beats at 120 BPM.
    expect(overlapOf(plan('long', 32, { length: 24 }), 120)).toBe(16);
    expect(overlapOf(plan('fade', 0, { length: 10 }), 0)).toBe(10);
  });
});
