import type { CuePoints, MixMap } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useUI } from '../lib/ui';
import { useClock, usePlayer } from '../player/store';
import { refreshUpcomingTransition } from '../player/transitions';
import { MixPointsDialog } from './MixPointsDialog';
import { NowPlaying } from './NowPlaying';
import { TrackList } from './TrackList';

// Whether saving asks for the coming transition afresh (the watcher itself is tested in transitions.test.ts).
vi.mock('../player/transitions', async (original) => ({ ...(await original<typeof import('../player/transitions')>()), refreshUpcomingTransition: vi.fn() }));

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 240, streamUrl: `/s/${id}` }) as Track;

/** 120 BPM from 0.5 s: a bar every 2 s (0.5, 2.5, 4.5…), a phrase every 8 s. */
type Song = MixMap & { cues?: CuePoints };
const map = (extra: Partial<Song> = {}): Song => ({
  version: 1,
  duration: 240,
  bpm: 120,
  firstBeat: 0.5,
  downbeatOffset: 0,
  gridStable: true,
  beatConfidence: 0.9,
  introEnd: 16.5,
  outroStart: 200.5,
  coldStart: false,
  coldEnd: false,
  soundEnd: 239,
  phraseEnergy: Array.from({ length: 30 }, (_, k) => 0.3 + (k % 5) / 10),
  ...extra,
});

let client: QueryClient;

function dialog(song = track(1)) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MixPointsDialog />
    </QueryClientProvider>,
  );
  act(() => useUI.getState().editMixPoints(song));
}

const slider = (name: 'Mix in' | 'Mix out') => screen.findByRole('slider', { name });
const valueOf = (el: HTMLElement) => Number(el.getAttribute('aria-valuenow'));

beforeEach(() => {
  usePrefs.setState({ transitions: 'dj' });
  useUI.setState({ mixPointsTrack: null });
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
  vi.mocked(refreshUpcomingTransition).mockClear();
  vi.spyOn(api, 'mixMaps').mockResolvedValue({ 'rec-1': map() });
  vi.spyOn(api, 'setCues').mockImplementation(async (_id, cues) => ({
    ...(cues.mixIn !== null && { mixIn: cues.mixIn }),
    ...(cues.mixOut !== null && { mixOut: cues.mixOut }),
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MixPointsDialog', () => {
  it('starts at the detected points, as sliders with their times', async () => {
    dialog();
    const mixIn = await slider('Mix in');
    expect(api.mixMaps).toHaveBeenCalledWith(['rec-1']);
    expect(valueOf(mixIn)).toBe(16.5);
    expect(mixIn.getAttribute('aria-valuetext')).toBe('0:16');
    const mixOut = await slider('Mix out');
    expect(valueOf(mixOut)).toBe(200.5);
    expect(mixOut.getAttribute('aria-valuetext')).toBe('3:20');
  });

  it('starts at the points set by hand, when there are some', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ cues: { mixIn: 32.5, mixOut: 180.5 } }) });
    dialog();
    expect(valueOf(await slider('Mix in'))).toBe(32.5);
    expect(valueOf(await slider('Mix out'))).toBe(180.5);
  });

  it('moves a marker one bar with the arrows and one phrase with Shift', async () => {
    dialog();
    const mixIn = await slider('Mix in');
    fireEvent.keyDown(mixIn, { key: 'ArrowRight' });
    expect(valueOf(mixIn)).toBe(18.5);
    fireEvent.keyDown(mixIn, { key: 'ArrowRight', shiftKey: true });
    expect(valueOf(mixIn)).toBe(26.5);
    fireEvent.keyDown(mixIn, { key: 'ArrowLeft' });
    expect(valueOf(mixIn)).toBe(24.5);
    fireEvent.keyDown(mixIn, { key: 'ArrowLeft', shiftKey: true });
    expect(valueOf(mixIn)).toBe(16.5);
  });

  it('goes to the next bar from a point between bars', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ introEnd: 17.2 }) });
    dialog();
    const mixIn = await slider('Mix in');
    fireEvent.keyDown(mixIn, { key: 'ArrowRight' });
    expect(valueOf(mixIn)).toBe(18.5);
  });

  it('keeps mix in at least a bar before mix out', async () => {
    dialog();
    const mixIn = await slider('Mix in');
    fireEvent.keyDown(mixIn, { key: 'End' });
    expect(valueOf(mixIn)).toBe(198.5);
    const mixOut = await slider('Mix out');
    fireEvent.keyDown(mixOut, { key: 'Home' });
    expect(valueOf(mixOut)).toBe(200.5);
  });

  it('snaps a dragged marker to the nearest bar', async () => {
    // The strip is 240 px wide from x = 0: a pixel per second.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 240, top: 0, height: 48, right: 240, bottom: 48, x: 0, y: 0, toJSON: () => ({}) });
    dialog();
    const mixOut = await slider('Mix out');
    fireEvent.pointerDown(mixOut, { pointerId: 1, clientX: 200.5, button: 0 });
    fireEvent.pointerMove(mixOut, { pointerId: 1, clientX: 150.2, buttons: 1 });
    expect(valueOf(mixOut)).toBe(150.5);
    fireEvent.pointerMove(mixOut, { pointerId: 1, clientX: 171.4, buttons: 1 });
    expect(valueOf(mixOut)).toBe(170.5);
    fireEvent.pointerUp(mixOut, { pointerId: 1, clientX: 171.4 });
    // After the release, moving does nothing.
    fireEvent.pointerMove(mixOut, { pointerId: 1, clientX: 100, buttons: 1 });
    expect(valueOf(mixOut)).toBe(170.5);
  });

  it('saves both points (a point left alone stays detected) and refreshes the mix maps', async () => {
    dialog();
    const mixIn = await slider('Mix in');
    fireEvent.keyDown(mixIn, { key: 'ArrowRight' });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setCues).toHaveBeenCalledWith('rec-1', { mixIn: 18.5, mixOut: null }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mix-maps'] }));
    expect(refreshUpcomingTransition).toHaveBeenCalledWith('rec-1');
    await waitFor(() => expect(useUI.getState().mixPointsTrack).toBeNull());
  });

  it('keeps a point set by hand when saving the other', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ cues: { mixOut: 180.5 } }) });
    dialog();
    fireEvent.keyDown(await slider('Mix in'), { key: 'ArrowLeft' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setCues).toHaveBeenCalledWith('rec-1', { mixIn: 14.5, mixOut: 180.5 }));
  });

  it('resets both points to the detected ones', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ cues: { mixIn: 32.5, mixOut: 180.5 } }) });
    dialog();
    await slider('Mix in');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(api.setCues).toHaveBeenCalledWith('rec-1', { mixIn: null, mixOut: null }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mix-maps'] }));
    expect(refreshUpcomingTransition).toHaveBeenCalledWith('rec-1');
    await waitFor(async () => expect(valueOf(await slider('Mix in'))).toBe(16.5));
    expect(valueOf(await slider('Mix out'))).toBe(200.5);
  });

  it('drags from the handle, and a cancelled touch ends the drag', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 240, top: 0, height: 48, right: 240, bottom: 48, x: 0, y: 0, toJSON: () => ({}) });
    dialog();
    const mixIn = await slider('Mix in');
    const handle = within(mixIn).getByText('In');
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 16.5, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 40.9, buttons: 1, pointerType: 'touch' });
    expect(valueOf(mixIn)).toBe(40.5);
    expect(document.activeElement).toBe(mixIn);
    fireEvent.pointerCancel(handle, { pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 80, buttons: 1, pointerType: 'touch' });
    expect(valueOf(mixIn)).toBe(40.5);
  });

  it('ends a drag released out of its sight (no button held any more)', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 240, top: 0, height: 48, right: 240, bottom: 48, x: 0, y: 0, toJSON: () => ({}) });
    dialog();
    const mixIn = await slider('Mix in');
    fireEvent.pointerDown(mixIn, { pointerId: 1, clientX: 16.5, button: 0 });
    fireEvent.pointerMove(mixIn, { pointerId: 1, clientX: 30, buttons: 0 });
    fireEvent.pointerMove(mixIn, { pointerId: 1, clientX: 60, buttons: 1 });
    expect(valueOf(mixIn)).toBe(16.5);
  });

  it('has nothing to save or reset until something changes', async () => {
    dialog();
    const mixIn = await slider('Mix in');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
    fireEvent.keyDown(mixIn, { key: 'ArrowRight' });
    expect(save.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
  });

  it('resets points only moved here without asking the server', async () => {
    dialog();
    const mixIn = await slider('Mix in');
    fireEvent.keyDown(mixIn, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(valueOf(mixIn)).toBe(16.5);
    expect(api.setCues).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends a point moved back onto the detected one as not set', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ cues: { mixIn: 18.5, mixOut: 180.5 } }) });
    dialog();
    fireEvent.keyDown(await slider('Mix in'), { key: 'ArrowLeft' });
    expect(screen.getAllByText('Detected').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setCues).toHaveBeenCalledWith('rec-1', { mixIn: null, mixOut: 180.5 }));
  });

  it('falls back to where the sound ends without a detected outro, as the planner does', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ outroStart: Number.NaN, soundEnd: 230 }) });
    dialog();
    expect(valueOf(await slider('Mix out'))).toBe(230);
  });

  it('shows detected points the wrong way round in order, within each marker’s range', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ introEnd: 230.5, outroStart: 10.5 }) });
    dialog();
    const mixIn = await slider('Mix in');
    const mixOut = await slider('Mix out');
    expect(valueOf(mixOut)).toBe(10.5);
    expect(valueOf(mixIn)).toBe(8.5);
    expect(Number(mixIn.getAttribute('aria-valuemax'))).toBe(8.5);
    expect(Number(mixOut.getAttribute('aria-valuemin'))).toBe(10.5);
  });

  it('starts on the mix-in marker once loaded', async () => {
    dialog();
    const mixIn = await slider('Mix in');
    await waitFor(() => expect(document.activeElement).toBe(mixIn));
  });

  it('says plainly when saving fails, and stays open', async () => {
    vi.mocked(api.setCues).mockRejectedValue(new ApiError('The mix-in point must come before the mix-out point', 400));
    dialog();
    fireEvent.keyDown(await slider('Mix in'), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The mix-in point must come before the mix-out point');
    expect(refreshUpcomingTransition).not.toHaveBeenCalled();
    expect(useUI.getState().mixPointsTrack).not.toBeNull();
  });

  it('moves by whole seconds when no beat was found, and says so', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ bpm: 0, introEnd: 12.3 }) });
    dialog();
    const mixIn = await slider('Mix in');
    expect(screen.getByText(/No steady beat was found/)).toBeTruthy();
    fireEvent.keyDown(mixIn, { key: 'ArrowRight' });
    expect(valueOf(mixIn)).toBe(13);
    fireEvent.keyDown(mixIn, { key: 'ArrowRight' });
    expect(valueOf(mixIn)).toBe(14);
  });

  it('explains when the song hasn’t been analysed', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({});
    dialog();
    expect(await screen.findByText(/hasn’t been analysed yet/)).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('plays the song from a marker in the main player', async () => {
    const seek = vi.spyOn(useClock.getState(), 'seek');
    usePlayer.setState({ queue: [track(1)], order: [0], pos: 0, playing: false });
    dialog();
    await slider('Mix in');
    fireEvent.click(screen.getByRole('button', { name: 'Play from mix out' }));
    expect(seek).toHaveBeenCalledWith(200.5);
    expect(usePlayer.getState().playing).toBe(true);
  });

  it('plays another song next to the queue, then from the marker', async () => {
    usePlayer.setState({ queue: [track(2), track(3)], order: [0, 1], pos: 0, playing: true });
    dialog();
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Mix in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play from mix in' }));
    const p = usePlayer.getState();
    expect(p.queue[p.order[p.pos]!]!.id).toBe(1);
    expect(p.order.map((i) => p.queue[i]!.id)).toEqual([2, 1, 3]);
    // The engine starts it there as it loads it.
    expect(p.startAt).toBe(16.5);
  });
});

describe('previews', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    usePlayer.setState({ queue: [track(1)], order: [0], pos: 0, playing: false });
  });
  afterEach(() => vi.useRealTimers());

  async function playMixIn() {
    dialog();
    await vi.waitFor(() => screen.getByRole('slider', { name: 'Mix in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play from mix in' }));
    expect(usePlayer.getState().playing).toBe(true);
  }

  it('plays 8 seconds from the marker, then pauses', async () => {
    await playMixIn();
    act(() => vi.advanceTimersByTime(7999));
    expect(usePlayer.getState().playing).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(usePlayer.getState().playing).toBe(false);
  });

  it('keeps playing once the listener seeks', async () => {
    await playMixIn();
    act(() => useClock.getState().seek(60));
    act(() => vi.advanceTimersByTime(10_000));
    expect(usePlayer.getState().playing).toBe(true);
  });

  it('starts the 8 seconds over from the other marker', async () => {
    await playMixIn();
    act(() => vi.advanceTimersByTime(5000));
    fireEvent.click(screen.getByRole('button', { name: 'Play from mix out' }));
    act(() => vi.advanceTimersByTime(5000));
    expect(usePlayer.getState().playing).toBe(true);
    act(() => vi.advanceTimersByTime(3000));
    expect(usePlayer.getState().playing).toBe(false);
  });

  it('keeps playing when the dialog is closed: the listener walked away with the song', async () => {
    await playMixIn();
    act(() => useUI.getState().closeMixPoints());
    act(() => vi.advanceTimersByTime(10_000));
    expect(usePlayer.getState().playing).toBe(true);
  });
});

describe('Edit mix points in the song menus', () => {
  const wrap = (children: React.ReactNode) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>,
    );

  beforeEach(() => {
    vi.spyOn(api, 'favorites').mockResolvedValue([]);
  });

  it('is in a song list’s menu only with DJ mix on, and opens the dialog', () => {
    usePrefs.setState({ transitions: 'crossfade' });
    wrap(<TrackList tracks={[track(1)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More for Song 1' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit mix points' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    act(() => usePrefs.setState({ transitions: 'dj' }));
    fireEvent.click(screen.getByRole('button', { name: 'More for Song 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit mix points' }));
    expect(useUI.getState().mixPointsTrack?.id).toBe(1);
  });

  it('is in Now Playing’s menu only with DJ mix on', () => {
    vi.spyOn(api, 'mixMaps').mockResolvedValue({});
    usePlayer.setState({ queue: [track(1)], order: [0], pos: 0, playing: false });
    useUI.setState({ nowPlayingOpen: true, lyricsOpen: false });
    usePrefs.setState({ transitions: 'off' });
    wrap(<NowPlaying />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit mix points' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    act(() => usePrefs.setState({ transitions: 'dj' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit mix points' }));
    expect(useUI.getState().mixPointsTrack?.id).toBe(1);
  });

  it('closes on Escape over Now Playing, leaving Now Playing open', async () => {
    vi.spyOn(api, 'mixMaps').mockResolvedValue({ 'rec-1': map() });
    usePlayer.setState({ queue: [track(1)], order: [0], pos: 0, playing: false });
    useUI.setState({ nowPlayingOpen: true, lyricsOpen: false });
    wrap(
      <>
        <NowPlaying />
        <MixPointsDialog />
      </>,
    );
    act(() => useUI.getState().editMixPoints(track(1)));
    await screen.findByRole('dialog', { name: 'Edit mix points' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(useUI.getState().mixPointsTrack).toBeNull();
    expect(useUI.getState().nowPlayingOpen).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit mix points' })).toBeNull());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUI.getState().nowPlayingOpen).toBe(false);
  });
});
