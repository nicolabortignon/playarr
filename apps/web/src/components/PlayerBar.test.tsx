import type { TransitionPlan } from '@playarr/mix';
import type { Album, AlbumDetail, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useUI } from '../lib/ui';
import { useBlend } from '../player/blend';
import { useSleep } from '../player/sleep';
import { useClock, usePlayer } from '../player/store';
import { useTransition } from '../player/transitions';
import { MiniPlayer, PlayerBar } from './PlayerBar';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: 17, artistId: 7, title: `Song ${id}`, artistName: 'Radiohead', albumTitle: 'OK Computer', duration: 200, streamUrl: `/s/${id}` }) as Track;
const OK_COMPUTER = { id: 17, title: 'OK Computer', artistId: 7, artistName: 'Radiohead', year: 1997, trackCount: 2, totalTrackCount: 2 } as Album;

/** A window wide enough for the column beside the page (1280 and up), or not. */
const room = (column: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 1280px)' && column, media: query, addEventListener() {}, removeEventListener() {} }));

function view(path = '/', bar = <PlayerBar />) {
  const router = createMemoryRouter(
    [
      { path: '/queue', element: bar },
      { path: '*', element: bar },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  room(false);
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
  useUI.setState({ sideColumn: null, nowPlayingOpen: false, lyricsOpen: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the idle player bar', () => {
  it('offers the album heard last and Feeling lucky, not controls that do nothing', async () => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([OK_COMPUTER]);
    view();
    expect(await screen.findByText('Heard last')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'OK Computer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Feeling lucky' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.queryByText('Nothing playing')).toBeNull();
  });

  it('resumes the album heard last', async () => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([OK_COMPUTER]);
    const album = vi.spyOn(api, 'album').mockResolvedValue({ ...OK_COMPUTER, tracks: [track(1), track(2)], discCount: 1, missingTracks: [] } as AlbumDetail);
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume OK Computer' }));
    await waitFor(() => expect(usePlayer.getState().queue.map((t) => t.title)).toEqual(['Song 1', 'Song 2']));
    expect(album).toHaveBeenCalledWith(17);
    expect(usePlayer.getState()).toMatchObject({ playing: true, source: { label: 'OK Computer', href: '/albums/17' } });
  });

  it('says nothing is playing and offers Feeling lucky when there’s no history yet', async () => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([]);
    const lucky = vi.spyOn(api, 'lucky').mockResolvedValue({ tracks: [track(3)], subtitle: 'Daytime' } as never);
    view();
    expect(await screen.findByText('Nothing playing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Resume/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Feeling lucky' }));
    await waitFor(() => expect(usePlayer.getState().queue.map((t) => t.title)).toEqual(['Song 3']));
    expect(lucky).toHaveBeenCalled();
  });

  it('is the player once something plays', async () => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([OK_COMPUTER]);
    usePlayer.setState({ queue: [track(1)], order: [0], pos: 0, playing: false });
    view();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Resume/ })).toBeNull();
    expect(screen.queryByText('Heard last')).toBeNull();
  });
});

describe('Queue and Lyrics in the player bar', () => {
  beforeEach(() => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([]);
    usePlayer.setState({ queue: [track(1)], order: [0], pos: 0, playing: true });
  });

  it('open and close the column beside the page where there’s room for it', () => {
    room(true);
    const router = view('/albums/17');
    const queue = screen.getByRole('button', { name: 'Queue' });
    fireEvent.click(queue);
    expect(useUI.getState().sideColumn).toBe('queue');
    expect(queue.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }));
    expect(useUI.getState().sideColumn).toBe('lyrics');
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }));
    expect(useUI.getState().sideColumn).toBeNull();
    // The page stays where it was.
    expect(router.state.location.pathname).toBe('/albums/17');
  });

  it('open the Queue page, and Now Playing’s words, where there isn’t', () => {
    room(false);
    const router = view('/albums/17');
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    expect(router.state.location.pathname).toBe('/queue');
    expect(useUI.getState().sideColumn).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lyrics' }));
    expect(useUI.getState()).toMatchObject({ nowPlayingOpen: true, lyricsOpen: true, sideColumn: null });
  });
});

describe('the end of a song', () => {
  const at = (time: number) => act(() => useClock.setState({ time, duration: 200 }));
  beforeEach(() => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([]);
    usePrefs.setState({ transitions: 'off', crossfade: 0 });
    useSleep.setState({ endsAt: null, endOfSong: false });
    useTransition.setState({ fromFileId: null, toFileId: null, result: null, ready: undefined });
    useBlend.setState({ blend: null });
    usePlayer.setState({ queue: [track(1), { ...track(2), title: 'Teardrop' }], order: [0, 1], pos: 0, playing: true, mixMode: 'auto' });
  });

  it('turns the mini player’s subtitle to what comes next, ten seconds before the song ends', async () => {
    view('/', <MiniPlayer />);
    await at(185);
    expect(screen.getByText('Radiohead')).toBeTruthy();
    await at(191);
    expect(screen.getByText('Next: Teardrop')).toBeTruthy();
    expect(screen.queryByText('Radiohead')).toBeNull();
  });

  it('says the mix comes on the next bar when DJ mix will blend them', async () => {
    usePrefs.setState({ transitions: 'dj' });
    const plan = { style: 'long', aStart: 180, beats: 32 } as TransitionPlan;
    useTransition.setState({ fromFileId: 1, toFileId: 2, result: { status: 'ready', plan, url: '/transitions/1.flac' } });
    view('/', <MiniPlayer />);
    await at(178.5);
    expect(screen.getByText('Mixing into Teardrop on the next bar')).toBeTruthy();
    await at(182);
    expect(screen.getByText('Mixing into Teardrop')).toBeTruthy();
  });

  it('keeps saying it’s mixing for as long as the blend is heard, even once the transitions store has let its answer go', async () => {
    usePrefs.setState({ transitions: 'dj' });
    const plan = { style: 'long', aStart: 180, beats: 32 } as TransitionPlan;
    const [song, teardrop] = usePlayer.getState().queue as [Track, Track];
    // At the mix point the store can take the transition's start for a seek, start over, and give up as too late.
    useTransition.setState({ fromFileId: 1, toFileId: 2, result: { status: 'gave up' }, ready: undefined });
    useBlend.setState({ blend: { from: song, to: teardrop, plan } });
    view('/', <MiniPlayer />);
    await at(184);
    expect(screen.getByText('Mixing into Teardrop')).toBeTruthy();
    // Teardrop shown, past the switch: the blend goes on a moment, but it's no longer mixing into what's shown.
    act(() => usePlayer.setState({ pos: 1 }));
    await at(21);
    expect(screen.queryByText('Mixing into Teardrop')).toBeNull();
    expect(screen.getByText('Radiohead')).toBeTruthy();
  });

  it('says nothing of what follows when the sleep timer stops after this song', async () => {
    useSleep.setState({ endOfSong: true });
    view('/', <MiniPlayer />);
    await at(195);
    expect(screen.queryByText(/Next:/)).toBeNull();
    expect(screen.getByText('Radiohead')).toBeTruthy();
  });

  it('turns the player bar’s artist link to what comes next too', async () => {
    view('/');
    await at(195);
    expect(screen.getByText('Next: Teardrop')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Radiohead' })).toBeNull();
  });
});
