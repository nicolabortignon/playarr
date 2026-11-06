import type { Album, AlbumDetail, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useUI } from '../lib/ui';
import { usePlayer } from '../player/store';
import { PlayerBar } from './PlayerBar';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: 17, artistId: 7, title: `Song ${id}`, artistName: 'Radiohead', albumTitle: 'OK Computer', duration: 200, streamUrl: `/s/${id}` }) as Track;
const OK_COMPUTER = { id: 17, title: 'OK Computer', artistId: 7, artistName: 'Radiohead', year: 1997, trackCount: 2, totalTrackCount: 2 } as Album;

/** A window wide enough for the column beside the page (1280 and up), or not. */
const room = (column: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 1280px)' && column, media: query, addEventListener() {}, removeEventListener() {} }));

function view(path = '/') {
  const router = createMemoryRouter(
    [
      { path: '/queue', element: <PlayerBar /> },
      { path: '*', element: <PlayerBar /> },
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
