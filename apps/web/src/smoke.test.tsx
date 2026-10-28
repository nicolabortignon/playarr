/**
 * End-to-end smoke test against a running Playarr server (pnpm dev:server).
 * Renders every route with real data and drives the player store.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { usePlayer } from './player/store';
import { routes } from './routes';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

let reachable = false;
beforeAll(async () => {
  reachable = await fetch('/api/health').then((r) => r.ok, () => false);
});

afterEach(() => {
  cleanup();
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const errors: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(' '));
  origError(...args);
};

describe('Playarr web against live server', () => {
  it.each([
    ['/', 'Recently added'],
    ['/artists', 'Artists'],
    ['/albums', 'Albums'],
    ['/albums?sort=added', 'Recently added'],
    ['/search', 'Try an artist'],
    ['/queue', /Nothing queued/],
    ['/nope', 'This groove is empty.'],
    ['/requests', 'Requests'],
    ['/favorites', 'Favorites'],
  ] as [string, string | RegExp][])('renders %s', async (path, text) => {
    if (!reachable) return;
    renderAt(path);
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('renders an artist page with discography', async () => {
    if (!reachable) return;
    const artists = (await (await fetch('/api/artists')).json()) as { id: number; name: string }[];
    const daft = artists.find((a) => a.name === 'Daft Punk') ?? artists[0]!;
    renderAt(`/artists/${daft.id}`);
    await screen.findByRole('heading', { name: 'Albums' });
    expect(screen.getAllByRole('link').some((l) => l.getAttribute('href')?.startsWith('/albums/'))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('searches the library', async () => {
    if (!reachable) return;
    renderAt('/search?q=daft');
    await screen.findByText('Top result');
    await screen.findByText('One More Time');
    expect(errors).toEqual([]);
  });

  it('shows music that is not in the library, with request buttons', async () => {
    if (!reachable) return;
    renderAt('/search?q=massive%20attack');
    await screen.findByRole('heading', { name: /Not in your library/ });
    const buttons = await screen.findAllByRole('button', { name: /Request/ }, { timeout: 20_000 });
    expect(buttons.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('renders a discover artist page with a discography', async () => {
    if (!reachable) return;
    renderAt('/discover/artists/10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8'); // Massive Attack
    await screen.findByRole('heading', { name: 'Massive Attack' }, { timeout: 20_000 });
    expect(screen.getByText('Mezzanine')).toBeTruthy();
    expect(errors).toEqual([]);
  });

  it('hearts a song on an album page and lists it under Favorites', async () => {
    if (!reachable) return;
    const album = (await (await fetch('/api/albums/8')).json()) as { tracks: { title: string; recordingId: string }[] };
    const song = album.tracks[1]!;
    await fetch(`/api/favorites/${song.recordingId}`, { method: 'DELETE' });

    renderAt('/albums/8');
    const heart = await screen.findByRole('button', { name: `Add “${song.title}” to favorites` });
    await act(async () => fireEvent.click(heart));
    // Optimistic: flips immediately, then the server confirms.
    await screen.findByRole('button', { name: `Remove “${song.title}” from favorites` });
    await waitFor(async () => {
      const favs = (await (await fetch('/api/favorites')).json()) as { recordingId: string }[];
      expect(favs.some((f) => f.recordingId === song.recordingId)).toBe(true);
    });
    cleanup();

    renderAt('/favorites');
    expect((await screen.findAllByText(song.title)).length).toBeGreaterThan(0);
    const unheart = screen.getByRole('button', { name: `Remove “${song.title}” from favorites` });
    await act(async () => fireEvent.click(unheart));
    await waitFor(async () => {
      const favs = (await (await fetch('/api/favorites')).json()) as { recordingId: string }[];
      expect(favs.some((f) => f.recordingId === song.recordingId)).toBe(false);
    });
    expect(errors).toEqual([]);
  });

  it('plays an album, queues, shuffles, and opens Now Playing', async () => {
    if (!reachable) return;
    const albums = (await (await fetch('/api/albums')).json()) as { id: number; title: string; trackCount: number }[];
    const album = albums.find((a) => a.trackCount > 3)!;
    renderAt(`/albums/${album.id}`);
    const playBtn = await screen.findByRole('button', { name: `Play ${album.title}` });
    await act(async () => fireEvent.click(playBtn));

    await waitFor(() => expect(usePlayer.getState().queue).toHaveLength(album.trackCount));
    const s = usePlayer.getState();
    expect(s.pos).toBe(0);
    expect(s.playing).toBe(true);

    // Next / previous.
    act(() => usePlayer.getState().next());
    expect(usePlayer.getState().pos).toBe(1);
    act(() => usePlayer.getState().prev(0));
    expect(usePlayer.getState().pos).toBe(0);

    // Shuffle keeps the current track first and preserves the set of tracks.
    act(() => usePlayer.getState().toggleShuffle());
    const shuffled = usePlayer.getState();
    expect(shuffled.order[shuffled.pos]).toBe(0);
    expect([...shuffled.order].sort((a, b) => a - b)).toEqual(s.order);
    act(() => usePlayer.getState().toggleShuffle());
    expect(usePlayer.getState().order).toEqual(s.order);

    // Play next inserts right after the current track.
    const extra = s.queue[s.queue.length - 1]!;
    act(() => usePlayer.getState().playNext([extra]));
    const after = usePlayer.getState();
    expect(after.queue[after.order[after.pos + 1]!]!.id).toBe(extra.id);

    // Now Playing opens from the player bar cover.
    const open = await screen.findAllByRole('button', { name: 'Open now playing' });
    await act(async () => fireEvent.click(open[0]!));
    await screen.findByRole('dialog', { name: 'Now playing' });
    expect(screen.getAllByText(s.queue[0]!.title).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
