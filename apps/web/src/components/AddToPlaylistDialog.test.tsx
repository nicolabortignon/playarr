import type { PlaylistCoverInfo, PlaylistDetail, PlaylistSummary, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useToasts } from '../lib/toast';
import { useUI } from '../lib/ui';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';

const COVER: PlaylistCoverInfo = { url: '/art/playlist/1?v=1', layout: 'ridges', variant: 0, frozen: true, stale: false, energy: 0.5, styles: [], analyzed: 0, total: 0, pending: false };
const playlist = (id: number, name: string, over: Partial<PlaylistSummary> = {}): PlaylistSummary => ({
  id,
  name,
  description: '',
  trackCount: 12,
  duration: 3000,
  cover: COVER,
  updatedAt: '2026-11-03T10:00:00Z',
  owner: 'Alex',
  shared: false,
  mine: true,
  ...over,
});
const song = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: 1, artistId: 1, title: `Song ${id}`, artistName: 'Massive Attack', albumTitle: 'Mezzanine', duration: 200, streamUrl: `/s/${id}` }) as Track;

const PLAYLISTS = [playlist(1, 'Road trip'), playlist(2, 'Late night'), playlist(3, 'Gym'), playlist(4, 'Sam’s mix', { mine: false, owner: 'Sam' })];

function picker(tracks: Track[]) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AddToPlaylistDialog />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  act(() => useUI.getState().openPlaylistPicker(tracks));
}

beforeEach(() => {
  vi.spyOn(api, 'playlists').mockResolvedValue(PLAYLISTS);
  vi.spyOn(api, 'playlistsHolding').mockResolvedValue({ 1: 2, 2: 1 });
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  act(() => useUI.getState().closePlaylistPicker());
  vi.restoreAllMocks();
});

describe('Add to playlist', () => {
  it('ticks the playlists that already hold the songs, and says how many of them the others hold', async () => {
    picker([song(1), song(2)]);
    const roadTrip = await screen.findByRole('checkbox', { name: /Road trip/ });
    await waitFor(() => expect(roadTrip.textContent).toContain('already in it'));
    expect(api.playlistsHolding).toHaveBeenCalledWith(['rec-1', 'rec-2']);
    expect(roadTrip.querySelector('.lucide-check')).toBeTruthy();
    const lateNight = screen.getByRole('checkbox', { name: /Late night/ });
    expect(lateNight.textContent).toContain('1 of 2 already in it');
    expect(lateNight.querySelector('.lucide-minus')).toBeTruthy();
    const gym = screen.getByRole('checkbox', { name: /Gym/ });
    expect(gym.textContent).not.toContain('already');
    // Only the account's own playlists take songs.
    expect(screen.queryByRole('checkbox', { name: /Sam’s mix/ })).toBeNull();
  });

  it('adds to several playlists at once', async () => {
    const add = vi.spyOn(api, 'addToPlaylist').mockImplementation(async (id) => ({ ...PLAYLISTS.find((p) => p.id === id)!, items: [] }) as PlaylistDetail);
    picker([song(1), song(2)]);
    const lateNight = await screen.findByRole('checkbox', { name: /Late night/ });
    // Nothing chosen yet: nothing to add to.
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(lateNight);
    fireEvent.click(screen.getByRole('checkbox', { name: /Gym/ }));
    expect(screen.getByRole('checkbox', { name: /Gym/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Add to 2 playlists' }));
    await waitFor(() => expect(useUI.getState().playlistPicker).toBeNull());
    expect(add.mock.calls).toEqual([
      [2, ['rec-1', 'rec-2']],
      [3, ['rec-1', 'rec-2']],
    ]);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Added 2 songs to “Late night” and “Gym”']);
  });

  it('chooses again on a second press, and says which playlists didn’t take the songs', async () => {
    vi.spyOn(api, 'addToPlaylist').mockImplementation(async (id) => {
      if (id === 3) throw new Error('Playlist not found');
      return { ...PLAYLISTS.find((p) => p.id === id)!, items: [] } as PlaylistDetail;
    });
    picker([song(1)]);
    const roadTrip = await screen.findByRole('checkbox', { name: /Road trip/ });
    fireEvent.click(roadTrip);
    fireEvent.click(roadTrip);
    expect(roadTrip.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('checkbox', { name: /Late night/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Gym/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add to 2 playlists' }));
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(2));
    expect(useToasts.getState().toasts.map((t) => [t.message, t.tone])).toEqual([
      ['Added “Song 1” to “Late night”', 'info'],
      ['Playlist not found', 'error'],
    ]);
  });
});
