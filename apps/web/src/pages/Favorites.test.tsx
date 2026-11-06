import type { Album, AlbumDetail, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePlayer } from '../player/store';
import { FavoritesPage } from './Favorites';

const MEZZANINE = { id: 70, title: 'Mezzanine', artistId: 7, artistName: 'Massive Attack' } as Album;
const song = { id: 8, fileId: 8, recordingId: 'r8', title: 'Angel', albumId: 70, artistId: 7, duration: 380, streamUrl: '/s/8' } as Track;

function view() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <FavoritesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Favorites', () => {
  it('says no hearts yet, and offers to jump back into the album heard last', async () => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([MEZZANINE]);
    vi.spyOn(api, 'album').mockResolvedValue({ ...MEZZANINE, tracks: [song], discCount: 1, missingTracks: [] } as AlbumDetail);
    view();
    // docs/design.md, The lines: Favorites.
    expect(await screen.findByText('No hearts yet.')).toBeTruthy();
    expect(screen.getByText('Heart a song and it lands here.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Jump back in' }));
    await waitFor(() => expect(usePlayer.getState().queue.map((t) => t.title)).toEqual(['Angel']));
    // Nothing to play yet: no Play button promising songs, and Jump back in rather than Feeling lucky.
    expect(screen.queryByRole('button', { name: 'Play Favorites' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Feeling lucky' })).toBeNull();
  });

  it('offers Feeling lucky when nothing has been heard yet', async () => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([]);
    view();
    expect(await screen.findByRole('button', { name: 'Feeling lucky' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jump back in' })).toBeNull();
  });
});
