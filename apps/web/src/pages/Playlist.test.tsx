import type { PlaylistCoverInfo, PlaylistDetail, PlaylistItem, Track } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useToasts } from '../lib/toast';
import { PlaylistPage } from './Playlist';

const COVER: PlaylistCoverInfo = { url: '/art/playlist/5?v=1', layout: 'ridges', variant: 0, frozen: true, stale: false, energy: 0.5, styles: [], analyzed: 1, total: 1, pending: false };
const SHARED: PlaylistDetail = {
  id: 5,
  name: 'Road trip',
  description: '',
  trackCount: 1,
  duration: 0,
  cover: COVER,
  updatedAt: '2026-11-03T10:00:00Z',
  owner: 'Nicola',
  shared: true,
  mine: false,
  items: [{ itemId: 1, recordingId: 'local:00000000000000cc', title: 'Sneaky Snitch', artistName: 'Kevin MacLeod', albumTitle: 'Royalty Free', addedAt: '2026-11-03T10:00:00Z' }],
};

const song = (id: number, title: string): Track =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: 70, artistId: 7, title, artistName: 'Massive Attack', albumTitle: 'Blue Lines', duration: 300, streamUrl: `/s/${id}` }) as Track;
const item = (itemId: number, track: Track): PlaylistItem => ({
  itemId,
  recordingId: track.recordingId,
  title: track.title,
  artistName: track.artistName,
  albumTitle: track.albumTitle,
  addedAt: '2026-11-03T10:00:00Z',
  track,
});
const MINE: PlaylistDetail = {
  ...SHARED,
  mine: true,
  shared: false,
  trackCount: 3,
  items: [item(1, song(1, 'Teardrop')), item(2, song(2, 'Unfinished Sympathy')), item(3, song(3, 'Safe from Harm'))],
};

/** The open menu's items, and its lines as "—". */
const menuEntries = () => [...screen.getByRole('menu').children].map((c) => (c.getAttribute('role') === 'separator' ? '—' : c.textContent));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
  useToasts.setState({ toasts: [] });
});

/** The toast on top, and its Undo pressed. */
const lastToast = () => useToasts.getState().toasts.at(-1);
const undo = () => act(() => useToasts.getState().act(lastToast()!.id));

function view(playlist: PlaylistDetail) {
  vi.spyOn(api, 'playlist').mockResolvedValue(playlist);
  vi.spyOn(api, 'playlistRecommendations').mockResolvedValue({ owned: [], missing: [], seedCount: 0 });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  const router = createMemoryRouter(
    [
      { path: '/playlists/:id', element: <PlaylistPage /> },
      { path: '/playlists', element: <p>All playlists</p> },
    ],
    { initialEntries: ['/playlists/5'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('PlaylistPage', () => {
  it('shows another account’s shared playlist without ways to change it', async () => {
    view(SHARED);
    expect(await screen.findByText('Shared by Nicola')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Drag to reorder/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Playlist actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete playlist' })).toBeNull();
  });

  it('says it’s shared in its meta line, and keeps what its cover means in the cover picker, after Play', async () => {
    view({ ...SHARED, mine: true, description: 'Songs for the A1', cover: { ...COVER, tempo: 96, energy: 0.42 } });
    const play = await screen.findByRole('button', { name: 'Play Road trip' });
    expect(screen.getByText('Shared with everyone')).toBeTruthy();
    // The description reads after the row; the cover's explanation isn't on the page at all.
    expect(play.compareDocumentPosition(screen.getByText('Songs for the A1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/traced from its loudness/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New cover' }));
    const about = within(await screen.findByRole('region', { name: 'About this cover' }));
    expect(about.getByText('Each line is a song, traced from its loudness over time.')).toBeTruthy();
    expect(about.getByText('96 BPM · energy 42%')).toBeTruthy();
  });

  it('keeps the one song menu on its songs, with the owner’s Move up, Move down and Remove after a line', async () => {
    view(MINE);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Unfinished Sympathy' }));
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
      'Move down',
      'Remove from playlist',
    ]);
  });

  it('moves a song from its menu or its handle’s arrow keys, and saves the order', async () => {
    const reorder = vi.spyOn(api, 'reorderPlaylist').mockImplementation(async (_id, itemIds) => ({ ...MINE, items: itemIds.map((i) => MINE.items.find((x) => x.itemId === i)!) }));
    view(MINE);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Teardrop' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(reorder).toHaveBeenLastCalledWith(5, [2, 1, 3]));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to reorder Safe from Harm' }), { key: 'ArrowUp' });
    await waitFor(() => expect(reorder).toHaveBeenLastCalledWith(5, [2, 3, 1]));
  });

  it('offers only its songs’ own menu to someone else, and nothing to move', async () => {
    view({ ...MINE, mine: false, shared: true });
    fireEvent.click(await screen.findByRole('button', { name: 'More for Teardrop' }));
    expect(menuEntries()).not.toContain('Move down');
    expect(menuEntries()).not.toContain('Remove from playlist');
    expect(screen.queryByRole('button', { name: /Drag to reorder/ })).toBeNull();
  });

  it('puts the playlist’s own actions after what everything you can play offers', async () => {
    view(MINE);
    fireEvent.click(await screen.findByRole('button', { name: 'Playlist actions' }));
    expect(menuEntries()).toEqual(['Play next', 'Add to queue', 'Add to playlist…', '—', 'Rename', 'New cover…', 'Share with everyone', 'Delete playlist']);
  });

  it('renames from a pencil beside the title, or from ⋯', async () => {
    view(MINE);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename playlist' }));
    expect(screen.getByRole('textbox', { name: 'Playlist name' })).toBeTruthy();
    cleanup();
    view(MINE);
    fireEvent.click(await screen.findByRole('button', { name: 'Playlist actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('textbox', { name: 'Playlist name' })).toBeTruthy();
  });

  it('lets the owner share it with everyone on the server', async () => {
    const update = vi.spyOn(api, 'updatePlaylist').mockResolvedValue({ ...SHARED, mine: true, shared: true });
    view({ ...SHARED, mine: true, shared: false });
    expect(await screen.findByRole('button', { name: 'Drag to reorder Sneaky Snitch' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Playlist actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share with everyone' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { shared: true }));
  });
  it('removes a song at once, and Undo puts it back where it was', async () => {
    const [first, second, third] = MINE.items as [PlaylistItem, PlaylistItem, PlaylistItem];
    vi.spyOn(api, 'removeFromPlaylist').mockResolvedValue({ ...MINE, items: [first, third] });
    // The server adds a song at the end, as a new item.
    const add = vi.spyOn(api, 'addToPlaylist').mockResolvedValue({ ...MINE, items: [first, third, { ...second, itemId: 9 }] });
    const reorder = vi.spyOn(api, 'reorderPlaylist').mockResolvedValue({ ...MINE, items: [first, { ...second, itemId: 9 }, third] });
    view(MINE);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Unfinished Sympathy' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from playlist' }));
    expect(screen.queryByRole('button', { name: 'Play Unfinished Sympathy' })).toBeNull();
    await waitFor(() => expect(lastToast()?.message).toBe('Removed “Unfinished Sympathy” from “Road trip”'));
    undo();
    await waitFor(() => expect(add).toHaveBeenCalledWith(5, ['rec-2']));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(5, [1, 9, 3]));
    expect(await screen.findByRole('button', { name: 'Play Unfinished Sympathy' })).toBeTruthy();
  });

  it('removes a song no longer in the library without an Undo, as it can’t be added again', async () => {
    vi.spyOn(api, 'removeFromPlaylist').mockResolvedValue({ ...SHARED, mine: true, items: [] });
    view({ ...SHARED, mine: true });
    fireEvent.click(await screen.findByRole('button', { name: 'More for Sneaky Snitch' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from playlist' }));
    await waitFor(() => expect(lastToast()?.message).toBe('Removed “Sneaky Snitch” from “Road trip”'));
    expect(lastToast()?.action).toBeUndefined();
  });

  it('stops sharing at once, and Undo shares it again', async () => {
    const update = vi.spyOn(api, 'updatePlaylist').mockImplementation(async (_id, patch) => ({ ...SHARED, mine: true, ...patch }));
    view({ ...SHARED, mine: true, shared: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Playlist actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop sharing' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { shared: false }));
    await waitFor(() => expect(lastToast()?.message).toBe('Stopped sharing “Road trip”'));
    undo();
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(5, { shared: true }));
  });

  it('asks before deleting the playlist, naming what goes and what stays', async () => {
    const destroy = vi.spyOn(api, 'deletePlaylist').mockResolvedValue();
    view(MINE);
    fireEvent.click(await screen.findByRole('button', { name: 'Playlist actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete playlist' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete “Road trip”?' });
    expect(ask.textContent).toContain('Its 3 songs stay in your library.');
    expect(destroy).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(destroy).toHaveBeenCalledWith(5));
    expect(await screen.findByText('All playlists')).toBeTruthy();
  });

  it('says an empty playlist is waiting for its first song, and where to find some', async () => {
    view({ ...MINE, items: [], trackCount: 0 });
    expect(await screen.findByText('This playlist is waiting for its first song.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find songs' }).getAttribute('href')).toBe('/search');
  });
});
