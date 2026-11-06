import type { PlaylistCoverInfo, PlaylistDetail } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('lets the owner share it with everyone on the server', async () => {
    const update = vi.spyOn(api, 'updatePlaylist').mockResolvedValue({ ...SHARED, mine: true, shared: true });
    view({ ...SHARED, mine: true, shared: false });
    expect(await screen.findByRole('button', { name: 'Drag to reorder Sneaky Snitch' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Playlist actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share with everyone' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { shared: true }));
  });
});
