import type { PlaylistCoverInfo, PlaylistDetail } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
});

function view(playlist: PlaylistDetail) {
  vi.spyOn(api, 'playlist').mockResolvedValue(playlist);
  vi.spyOn(api, 'playlistRecommendations').mockResolvedValue({ owned: [], missing: [], seedCount: 0 });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  const router = createMemoryRouter([{ path: '/playlists/:id', element: <PlaylistPage /> }], { initialEntries: ['/playlists/5'] });
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

  it('lets the owner share it with everyone on the server', async () => {
    const update = vi.spyOn(api, 'updatePlaylist').mockResolvedValue({ ...SHARED, mine: true, shared: true });
    view({ ...SHARED, mine: true, shared: false });
    expect(await screen.findByRole('button', { name: 'Drag to reorder Sneaky Snitch' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Playlist actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share with everyone' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { shared: true }));
  });
});
