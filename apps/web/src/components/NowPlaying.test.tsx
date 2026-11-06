import type { MixMapEntry } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useUI } from '../lib/ui';
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
