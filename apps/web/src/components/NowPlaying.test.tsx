import type { MixMapEntry, TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useUI } from '../lib/ui';
import { useBlend } from '../player/blend';
import { setPulseSource } from '../player/pulse';
import { useSleep } from '../player/sleep';
import { useClock, usePlayer } from '../player/store';
import { NowPlaying } from './NowPlaying';
import { MiniPlayer } from './PlayerBar';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 200, streamUrl: `/s/${id}` }) as Track;

function wrap(children: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The open menu's items, and its lines as "—". */
const menuEntries = () => [...screen.getByRole('menu').children].map((c) => (c.getAttribute('role') === 'separator' ? '—' : c.textContent));

beforeEach(() => {
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  vi.spyOn(api, 'lyrics').mockResolvedValue(null);
  usePrefs.setState({ transitions: 'off', motion: 'full' });
  usePlayer.setState({ queue: [1, 2, 3].map(track), order: [0, 1, 2], pos: 0, playing: true });
  useUI.setState({ nowPlayingOpen: true, lyricsOpen: false });
  useSleep.setState({ endsAt: null, endOfSong: false, sleptAt: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Now Playing', () => {
  it('gives the song playing the one song menu, without queueing it again, and Open queue after a line', () => {
    wrap(<NowPlaying />);
    fireEvent.click(screen.getByRole('button', { name: 'More for “Song 1”' }));
    expect(menuEntries()).toEqual(['Add to playlist…', 'Start radio', 'Go to album', 'Go to artist', 'Show metadata', '—', 'Open queue']);
  });

  it('gives Up next’s songs the queue’s menu, and a press plays from there', () => {
    wrap(<NowPlaying />);
    fireEvent.click(screen.getByRole('button', { name: 'More for “Song 3”' }));
    expect(menuEntries()).toEqual([
      'Play next',
      'Add to queue',
      'Add to playlist…',
      'Start radio',
      'Go to album',
      'Go to artist',
      'Show metadata',
      '—',
      'Move up',
      'Remove from queue',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    const s = usePlayer.getState();
    expect(s.order.slice(s.pos + 1).map((i) => s.queue[i]!.title)).toEqual(['Song 3', 'Song 2']);
    fireEvent.click(screen.getByRole('button', { name: 'Play Song 2' }));
    expect(usePlayer.getState().pos).toBe(2);
  });
});

describe('Now Playing’s Open queue', () => {
  const room = (column: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 1280px)' && column, media: query, addEventListener() {}, removeEventListener() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it('opens the queue beside the page where there’s room, closing Now Playing', () => {
    room(true);
    useUI.setState({ sideColumn: null });
    wrap(<NowPlaying />);
    fireEvent.click(screen.getByRole('button', { name: 'More for “Song 1”' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open queue' }));
    expect(useUI.getState()).toMatchObject({ sideColumn: 'queue', nowPlayingOpen: false });
  });

  it('opens the Queue page where there isn’t', () => {
    room(false);
    useUI.setState({ sideColumn: null });
    const router = createMemoryRouter([{ path: '*', element: <NowPlaying /> }], { initialEntries: ['/albums/1'] });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More for “Song 1”' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open queue' }));
    expect(router.state.location.pathname).toBe('/queue');
    expect(useUI.getState()).toMatchObject({ sideColumn: null, nowPlayingOpen: false });
  });
});

describe('Mini player', () => {
  it('is an Open now playing button beside its own controls, not buttons inside a button', () => {
    wrap(<MiniPlayer />);
    const open = screen.getByRole('button', { name: 'Open now playing' });
    expect(open.tagName).toBe('BUTTON');
    expect(open.querySelector('button')).toBeNull();
    expect(open.textContent).toContain('Song 1');
    for (const name of ['Add “Song 1” to Favorites', 'Pause', 'Next']) {
      const control = screen.getByRole('button', { name });
      expect(open.contains(control)).toBe(false);
    }
    fireEvent.click(open);
    expect(useUI.getState().nowPlayingOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(usePlayer.getState().pos).toBe(1);
  });
});

/** A window with a mouse (a fine pointer that hovers), or a touch screen. */
const pointer = (mouse: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)' && mouse,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

describe('Now Playing’s cover', () => {
  afterEach(() => vi.unstubAllGlobals());
  const cover = () => screen.getByRole('img', { name: 'A' }).closest('.aspect-square') as HTMLElement;

  it('settles back with a softer shadow while paused, and lifts again playing', () => {
    usePlayer.setState({ queue: [{ ...track(1), coverUrl: '/art/album/1/cover' }, track(2)], order: [0, 1], pos: 0 });
    wrap(<NowPlaying />);
    expect(cover().className).toContain('shadow-cover-hero');
    act(() => usePlayer.setState({ playing: false }));
    expect(cover().className).not.toContain('shadow-cover-hero');
    expect(cover().className).toContain('shadow-cover');
    act(() => usePlayer.setState({ playing: true }));
    expect(cover().className).toContain('shadow-cover-hero');
  });

  it('tilts towards a mouse and catches its sheen, but not on a touch screen or under Reduce Motion', () => {
    pointer(true);
    wrap(<NowPlaying />);
    expect(document.querySelector('[data-tilt]')).not.toBeNull();
    cleanup();
    pointer(false);
    wrap(<NowPlaying />);
    expect(document.querySelector('[data-tilt]')).toBeNull();
    cleanup();
    pointer(true);
    usePrefs.setState({ motion: 'reduce' });
    wrap(<NowPlaying />);
    expect(document.querySelector('[data-tilt]')).toBeNull();
  });

  it('has a backdrop drifting through its colors, still under Reduce Motion', () => {
    wrap(<NowPlaying />);
    expect(document.querySelector('[data-drift]')?.className).toContain('animate-drift');
    cleanup();
    usePrefs.setState({ motion: 'reduce' });
    wrap(<NowPlaying />);
    expect(document.querySelector('[data-drift]')).toBeNull();
    expect(document.querySelector('.animate-drift')).toBeNull();
  });
});

describe('Now Playing’s seek bar', () => {
  /** Song 1, analyzed: a beat at 120 BPM, so 8 s phrases, quiet then a drop. */
  const analyzed = { version: 99, duration: 200, bpm: 120, firstBeat: 0, downbeatOffset: 0, phraseEnergy: [0.2, 0.3, 1, 0.9, 0.1, 0.8] } as unknown as MixMapEntry;

  it('shows an analyzed song’s energy under the line, inside the slider, so pressing it seeks there', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': analyzed });
    useClock.setState({ time: 0, duration: 200 });
    wrap(<NowPlaying />);
    const slider = screen.getByRole('slider', { name: 'Seek' });
    await waitFor(() => expect(slider.querySelector('[data-energy="6"]')).not.toBeNull());
    expect(api.mixMaps).toHaveBeenCalledWith(['rec-1']);
  });

  it('keeps the strip’s room, empty, for a song not analyzed', async () => {
    useClock.setState({ time: 0, duration: 200 });
    wrap(<NowPlaying />);
    await waitFor(() => expect(api.mixMaps).toHaveBeenCalled());
    const slider = screen.getByRole('slider', { name: 'Seek' });
    expect(slider.querySelector('[data-energy]')).toBeNull();
    expect(slider.querySelector('.h-5')).not.toBeNull();
  });
});

describe('the sleep timer’s end in Now Playing', () => {
  it('dims to a moon and “Sleep well”, and a touch wakes it', () => {
    usePlayer.setState({ playing: false });
    wrap(<NowPlaying />);
    act(() => useSleep.setState({ sleptAt: Date.now() }));
    const goodnight = screen.getByRole('status', { name: 'Sleep well' });
    expect(goodnight.textContent).toContain('Sleep well');
    fireEvent.pointerDown(goodnight);
    expect(useSleep.getState().sleptAt).toBeNull();
  });

  it('wakes when the music plays again', () => {
    usePlayer.setState({ playing: false });
    wrap(<NowPlaying />);
    act(() => useSleep.setState({ sleptAt: Date.now() }));
    expect(screen.getByRole('status', { name: 'Sleep well' })).toBeTruthy();
    act(() => usePlayer.setState({ playing: true }));
    expect(useSleep.getState().sleptAt).toBeNull();
  });

  it('says nothing to Now Playing opened long after the music stopped', () => {
    usePlayer.setState({ playing: false });
    useSleep.setState({ sleptAt: Date.now() - 60_000 });
    wrap(<NowPlaying />);
    expect(screen.queryByRole('status', { name: 'Sleep well' })).toBeNull();
  });
});

describe('a DJ blend in Now Playing', () => {
  const plan = { style: 'long', aStart: 180, length: 20, aGain: [{ at: 0, value: 1 }, { at: 16, value: 0 }], bGain: [{ at: 0, value: 0 }, { at: 8, value: 1 }] } as Partial<TransitionPlan> as TransitionPlan;
  afterEach(() => useBlend.setState({ blend: null }));

  it('says “Mixing into Teardrop” for as long as the two play together, past the switch to it', () => {
    const teardrop = { ...track(2), title: 'Teardrop' };
    usePlayer.setState({ queue: [track(1), teardrop, track(3)], order: [0, 1, 2], pos: 0 });
    wrap(<NowPlaying />);
    expect(screen.queryByText('Mixing into Teardrop')).toBeNull();
    act(() => useBlend.setState({ blend: { from: track(1), to: teardrop, plan } }));
    expect(screen.getByText('Mixing into Teardrop')).toBeTruthy();
    // The switch: Teardrop is the song playing now, the first still fading out under it.
    act(() => usePlayer.setState({ pos: 1 }));
    expect(screen.getByText('Mixing into Teardrop')).toBeTruthy();
    act(() => useBlend.setState({ blend: null }));
    expect(screen.queryByText('Mixing into Teardrop')).toBeNull();
  });
});

describe('Now Playing’s breathing glow', () => {
  /** 120 BPM from its first downbeat at 1 s: bars every 2 s; a quiet phrase, then a loud one. */
  const analyzed = { version: 99, duration: 200, bpm: 120, firstBeat: 0.5, downbeatOffset: 1, gridStable: true, beatConfidence: 0.9, phraseEnergy: [0.2, 1] } as unknown as MixMapEntry;
  let songTime = 9;
  const glow = () => document.querySelector<HTMLElement>('[data-glow]');
  beforeEach(() => {
    songTime = 9;
    setPulseSource({ songTime: () => songTime, meter: () => null, blend: () => null });
  });
  afterEach(() => setPulseSource(null));

  it('breathes on each bar’s downbeat, barely there and deeper in a loud phrase', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': analyzed });
    wrap(<NowPlaying />);
    await waitFor(() => expect(glow()).not.toBeNull());
    // It comes in over 0.7 s as Now Playing opens, then follows the bars: fullest on the downbeat at 9 s (a loud phrase).
    await waitFor(() => expect(Number(glow()!.style.opacity)).toBeCloseTo(0.24, 2), { timeout: 2000 });
    // Halfway through the bar it has breathed out.
    songTime = 10;
    await waitFor(() => expect(Number(glow()!.style.opacity)).toBeLessThan(0.11));
    // The same downbeat in a quiet phrase breathes less deep.
    songTime = 3;
    await waitFor(() => expect(Number(glow()!.style.opacity)).toBeCloseTo(0.176, 2));
    // Never more than barely visible.
    expect(Number(glow()!.style.opacity)).toBeLessThan(0.3);
  });

  it('fades away while paused', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': analyzed });
    wrap(<NowPlaying />);
    await waitFor(() => expect(Number(glow()?.style.opacity)).toBeGreaterThan(0.1), { timeout: 2000 });
    act(() => usePlayer.setState({ playing: false }));
    expect(glow()!.style.opacity).toBe('0');
    expect(glow()!.style.transition).toContain('opacity');
  });

  it('isn’t there for a song without a beat grid, nor under Reduce Motion', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': { ...analyzed, gridStable: false } });
    wrap(<NowPlaying />);
    await waitFor(() => expect(api.mixMaps).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(glow()).toBeNull();
    cleanup();
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': analyzed });
    usePrefs.setState({ motion: 'reduce' });
    wrap(<NowPlaying />);
    await new Promise((r) => setTimeout(r, 20));
    expect(glow()).toBeNull();
  });
});

describe('the cover growing into Now Playing', () => {
  /** The elements carrying a view-transition name, by name: each name once, or the browser would skip the transition. */
  function named(): Record<string, HTMLElement> {
    const entries = [...document.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.viewTransitionName).map((el) => [el.style.viewTransitionName, el] as const);
    expect(new Set(entries.map(([name]) => name)).size).toBe(entries.length);
    return Object.fromEntries(entries);
  }
  /** The browser's View Transitions API, run at once: what's named for the picture before, and after the change. */
  function viewTransitions() {
    const pictures: { before: Record<string, HTMLElement>; after: Record<string, HTMLElement> }[] = [];
    let finish = () => {};
    const start = vi.fn((update: () => void) => {
      const before = named();
      update();
      pictures.push({ before, after: named() });
      const finished = new Promise<void>((done) => (finish = done));
      return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition() {} };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    return { start, pictures, finish: () => act(async () => finish()) };
  }
  afterEach(() => {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  const players = () => wrap(<><MiniPlayer /><NowPlaying /></>);
  const playerCover = () => screen.getByRole('button', { name: 'Open now playing' }).querySelector<HTMLElement>('[data-cover]')!.parentElement!;
  const sheet = () => screen.queryByRole('dialog', { name: 'Now playing' });

  it('grows the player’s cover into Now Playing’s, the sheet fading in around it rather than sliding up', async () => {
    useUI.setState({ nowPlayingOpen: false });
    const { start, pictures, finish } = viewTransitions();
    players();
    fireEvent.click(screen.getByRole('button', { name: 'Open now playing' }));
    expect(start).toHaveBeenCalledOnce();
    const { before, after } = pictures[0]!;
    // Before: the player's cover. After: Now Playing's, and its sheet.
    expect(before['now-playing-cover']).toBe(playerCover());
    expect(before['now-playing']).toBeUndefined();
    expect(after['now-playing']).toBe(sheet());
    expect(sheet()!.contains(after['now-playing-cover']!)).toBe(true);
    expect(sheet()!.style.transform).not.toContain('100%');
    await finish();
    expect(named()).toEqual({});
  });

  it('shrinks it home as Now Playing closes, the sheet gone at once rather than sliding away', async () => {
    useUI.setState({ nowPlayingOpen: true });
    const { pictures, finish } = viewTransitions();
    players();
    fireEvent.click(screen.getByRole('button', { name: 'Close now playing' }));
    const { before, after } = pictures[0]!;
    expect(before['now-playing']).toBeTruthy();
    expect(before['now-playing-cover']).not.toBe(playerCover());
    expect(after['now-playing-cover']).toBe(playerCover());
    expect(sheet()).toBeNull();
    await finish();
    expect(named()).toEqual({});
    expect(useUI.getState().nowPlayingOpen).toBe(false);
  });

  it('just opens and closes it under Reduce Motion, or where the browser can’t', () => {
    useUI.setState({ nowPlayingOpen: false });
    players();
    fireEvent.click(screen.getByRole('button', { name: 'Open now playing' }));
    expect(useUI.getState()).toMatchObject({ nowPlayingOpen: true, nowPlayingGrown: false, coverMorph: null });
    fireEvent.click(screen.getByRole('button', { name: 'Close now playing' }));
    expect(useUI.getState().nowPlayingOpen).toBe(false);
    cleanup();
    usePrefs.setState({ motion: 'reduce' });
    const { start } = viewTransitions();
    players();
    fireEvent.click(screen.getByRole('button', { name: 'Open now playing' }));
    expect(start).not.toHaveBeenCalled();
    expect(useUI.getState().nowPlayingOpen).toBe(true);
    expect(named()).toEqual({});
  });
});
