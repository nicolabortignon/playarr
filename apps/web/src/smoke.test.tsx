/**
 * End-to-end smoke test against a running Playarr server (pnpm dev:server).
 * Renders every route with real data and drives the player store.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { healQueue } from './player/healQueue';
import { usePlayer } from './player/store';
import { useToasts } from './lib/toast';
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
  useToasts.setState({ toasts: [] });
  // Each test asserts on its own console errors only.
  errors.length = 0;
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
    ['/playlists', 'New playlist'],
    ['/library', 'Library'],
  ] as [string, string | RegExp][])('renders %s', async (path, text) => {
    if (!reachable) return;
    renderAt(path);
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    expect(errors.join('\n')).toBe('');
  });

  it('renders an artist page with discography', async () => {
    if (!reachable) return;
    const artists = (await (await fetch('/api/artists')).json()) as { id: number; name: string }[];
    const daft = artists.find((a) => a.name === 'Daft Punk') ?? artists[0]!;
    renderAt(`/artists/${daft.id}`);
    await screen.findByRole('heading', { name: 'Albums' });
    expect(screen.getAllByRole('link').some((l) => l.getAttribute('href')?.startsWith('/albums/'))).toBe(true);
    expect(errors.join('\n')).toBe('');
  });

  it('searches the library', async () => {
    if (!reachable) return;
    renderAt('/search?q=daft');
    await screen.findByText('Top result');
    await screen.findByText('One More Time');
    expect(errors.join('\n')).toBe('');
  });

  it('shows music that is not in the library, with request buttons', async () => {
    if (!reachable) return;
    renderAt('/search?q=massive%20attack');
    await screen.findByRole('heading', { name: /Not in your library/ });
    const buttons = await screen.findAllByRole('button', { name: /Request/ }, { timeout: 20_000 });
    expect(buttons.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toBe('');
  });

  it('links artist and album names in both search song lists', async () => {
    if (!reachable) return;
    renderAt('/search?q=teardrop');

    // Songs outside the library: every row links its artist; unknown ids go through the name lookup.
    const songs = (await screen.findByRole('heading', { name: 'Songs' }, { timeout: 20_000 })).closest('section')!;
    const rows = within(songs).getAllByRole('listitem');
    for (const row of rows) {
      expect(within(row).getAllByRole('link').length).toBeGreaterThanOrEqual(2);
    }
    const hrefs = within(songs).getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.startsWith('/discover/artists/') && h.includes('?album='))).toBe(true);
    expect(hrefs.some((h) => h.startsWith('/discover/artist?name='))).toBe(true);
    cleanup();

    // Library songs: artist and album pages, and following a link doesn't play the song.
    const router = renderAt('/search?q=daft');
    await screen.findByText('One More Time');
    const tracks = screen.getByRole('heading', { name: 'Tracks' }).closest('section')!;
    const links = within(tracks).getAllByRole('link');
    expect(links.some((a) => /^\/albums\/\d+$/.test(a.getAttribute('href') ?? ''))).toBe(true);
    const artistLink = links.find((a) => /^\/artists\/\d+$/.test(a.getAttribute('href') ?? ''))!;
    const href = artistLink.getAttribute('href')!;
    await act(async () => fireEvent.click(artistLink));
    await waitFor(() => expect(router.state.location.pathname).toBe(href));
    expect(usePlayer.getState().queue).toHaveLength(0);
    expect(errors.join('\n')).toBe('');
  });

  it('resolves an artist name to their discography and highlights the album', async () => {
    if (!reachable) return;
    const router = renderAt('/discover/artist?name=Portishead&album=Dummy');
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/discover\/artists\/[0-9a-f-]{36}$/), {
      timeout: 15_000,
    });
    expect(router.state.location.search).toBe('?album=Dummy');
    await screen.findByRole('heading', { name: 'Portishead' }, { timeout: 20_000 });
    // Needs MusicBrainz; when it's unreachable the page must say so instead.
    await waitFor(
      () => {
        const card = document.querySelector('[data-highlighted]');
        const failed = screen.queryByText(/Couldn’t load the discography/);
        expect(card?.textContent?.includes('Dummy') || failed).toBeTruthy();
      },
      { timeout: 20_000 },
    );
    expect(errors.join('\n')).toBe('');
  });

  it('renders a discover artist page with a discography', async () => {
    if (!reachable) return;
    renderAt('/discover/artists/10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8'); // Massive Attack
    await screen.findByRole('heading', { name: 'Massive Attack' }, { timeout: 20_000 });
    // Needs MusicBrainz over the internet; when it's unreachable the page must say so, not "no albums".
    const loaded = screen.queryByText('Mezzanine');
    const failed = screen.queryByText(/Couldn’t load the discography/);
    expect(loaded ?? failed).toBeTruthy();
    expect(errors.join('\n')).toBe('');
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
    expect(errors.join('\n')).toBe('');
  });

  it('refreshes queue tracks saved before favorites existed, so the player shows a heart', async () => {
    if (!reachable) return;
    const album = (await (await fetch('/api/albums/8')).json()) as { tracks: Record<string, unknown>[] };
    // Simulate a queue persisted by an older version: tracks without recordingId.
    const old = album.tracks.slice(0, 3).map(({ recordingId: _r, ...t }) => t) as never[];
    usePlayer.setState({ queue: old, order: [0, 1, 2], pos: 1, playing: false });
    await healQueue();
    const { queue, pos } = usePlayer.getState();
    expect(queue.every((t) => t.recordingId)).toBe(true);
    expect(pos).toBe(1);

    renderAt('/');
    const current = queue[1]!;
    await screen.findAllByRole('button', { name: `Add “${current.title}” to favorites` });
    expect(errors.join('\n')).toBe('');
  });

  it('creates a playlist, adds an album to it from the album menu, and shows it', async () => {
    if (!reachable) return;
    const name = `Smoke test ${Date.now()}`;

    let id: number | undefined;
    try {
      // Create from the Playlists page; the dialog navigates to the new playlist.
      const router = renderAt('/playlists');
      const newButtons = await screen.findAllByRole('button', { name: /New playlist/ });
      await act(async () => fireEvent.click(newButtons[newButtons.length - 1]!));
      const input = await screen.findByRole('textbox', { name: 'Playlist name' });
      fireEvent.change(input, { target: { value: name } });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
      await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/playlists\/\d+$/));
      id = Number(router.state.location.pathname.split('/').pop());
      await screen.findByRole('heading', { name });
      cleanup();

      // Add a whole album via its ⋯ menu → Add to playlist… → pick the playlist.
      const album = (await (await fetch('/api/albums/8')).json()) as { title: string; tracks: { title: string }[] };
      renderAt('/albums/8');
      await screen.findByRole('heading', { name: album.title });
      const [albumMenu] = screen.getAllByRole('button', { name: 'More actions' });
      await act(async () => fireEvent.click(albumMenu!));
      const addItem = await screen.findByRole('menuitem', { name: 'Add to playlist…' });
      await act(async () => fireEvent.click(addItem));
      const picker = await screen.findByRole('dialog', { name: /^Add/ });
      await act(async () => fireEvent.click(within(picker).getByRole('button', { name: new RegExp(name) })));
      await waitFor(async () => {
        const p = (await (await fetch(`/api/playlists/${id}`)).json()) as { trackCount: number };
        expect(p.trackCount).toBe(album.tracks.length);
      });
      cleanup();

      renderAt(`/playlists/${id}`);
      await screen.findByRole('heading', { name });
      expect((await screen.findAllByText(album.tracks[0]!.title)).length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: `Play ${name}` })).toBeTruthy();
    } finally {
      // Clean up even when an assertion fails, so test playlists don't pile up.
      if (id) await fetch(`/api/playlists/${id}`, { method: 'DELETE' });
    }
    expect(errors.join('\n')).toBe('');
  });

  it('generates a playlist cover from its songs and explains it', async () => {
    if (!reachable) return;
    const artists = (await (await fetch('/api/artists')).json()) as { id: number; name: string }[];
    const daft = artists.find((a) => a.name === 'Daft Punk');
    if (!daft) return;
    const tracks = ((await (await fetch(`/api/artists/${daft.id}/tracks`)).json()) as { recordingId: string }[]).slice(0, 3);

    let id: number | undefined;
    try {
      const created = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `Smoke cover ${Date.now()}`, recordingIds: tracks.map((t) => t.recordingId) }),
      });
      id = ((await created.json()) as { id: number }).id;

      renderAt(`/playlists/${id}`);
      const cover = await screen.findByRole('img', { name: /^Smoke cover/ });
      const src = cover.querySelector('img')!.getAttribute('src')!;
      expect(src).toMatch(new RegExp(`^/art/playlist/${id}\\?v=\\w+&size=\\d+$`));
      const image = await fetch(src);
      expect(image.headers.get('content-type')).toBe('image/webp');
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(1000);

      // Either still listening to the songs, or the facts behind the finished cover.
      await screen.findByText(/Listening to the songs|energy \d+%/);
    } finally {
      if (id) await fetch(`/api/playlists/${id}`, { method: 'DELETE' });
    }
    expect(errors.join('\n')).toBe('');
  });

  it('recommends similar songs under a playlist, adds an owned one, and links artists and albums', async () => {
    if (!reachable) return;
    const artists = (await (await fetch('/api/artists')).json()) as { id: number; name: string }[];
    const seedArtists = artists.filter((a) => ['Daft Punk', 'Moby', 'Air'].includes(a.name));
    const tracks = (
      await Promise.all(seedArtists.map(async (a) => (await (await fetch(`/api/artists/${a.id}/tracks`)).json()) as { recordingId: string }[]))
    ).flatMap((t) => t.slice(0, 4));
    if (!tracks.length) return;

    let id: number | undefined;
    try {
      const created = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `Smoke recs ${Date.now()}`, recordingIds: tracks.map((t) => t.recordingId) }),
      });
      id = ((await created.json()) as { id: number }).id;

      const router = renderAt(`/playlists/${id}`);
      await screen.findByRole('heading', { name: 'Songs like these' });
      const section = await screen.findByRole('region', { name: 'Songs like these' });
      // ListenBrainz is a live dependency, so give it time.
      await within(section).findByRole('heading', { name: 'Already in your library' }, { timeout: 15_000 });
      within(section).getByRole('heading', { name: 'Not in your library yet' });
      // Missing songs get request buttons (not clicked: that would really ask Lidarr to download).
      expect(within(section).getAllByRole('button', { name: /Request|In library|Search again|Retry/ }).length).toBeGreaterThan(0);

      const [addFirst] = within(section).getAllByRole('button', { name: /^Add .* to playlist$/ });
      const label = addFirst!.getAttribute('aria-label')!;
      await act(async () => fireEvent.click(addFirst!));
      await waitFor(async () => {
        const p = (await (await fetch(`/api/playlists/${id}`)).json()) as { trackCount: number };
        expect(p.trackCount).toBe(tracks.length + 1);
      });
      await waitFor(() => expect(within(section).queryByRole('button', { name: label })).toBeNull());

      // Artist and album names are links. Albums you don't have point at the artist's discography.
      const missingGroup = within(within(section).getByRole('heading', { name: 'Not in your library yet' }).parentElement!);
      expect(missingGroup.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('/discover/artists/'))).toBe(true);
      // On an owned row, following the artist link navigates without also playing the song.
      const ownedGroup = within(within(section).getByRole('heading', { name: 'Already in your library' }).parentElement!);
      const ownedLinks = ownedGroup.getAllByRole('link').map((a) => a.getAttribute('href'));
      expect(ownedLinks.some((h) => /^\/albums\/\d+$/.test(h ?? ''))).toBe(true);
      const artistLink = ownedGroup.getAllByRole('link').find((a) => /^\/artists\/\d+$/.test(a.getAttribute('href') ?? ''))!;
      const href = artistLink.getAttribute('href')!;
      await act(async () => fireEvent.click(artistLink));
      await waitFor(() => expect(router.state.location.pathname).toBe(href));
      expect(usePlayer.getState().queue).toHaveLength(0);
    } finally {
      if (id) await fetch(`/api/playlists/${id}`, { method: 'DELETE' });
    }
    expect(errors.join('\n')).toBe('');
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
    expect(errors.join('\n')).toBe('');
  });
});
