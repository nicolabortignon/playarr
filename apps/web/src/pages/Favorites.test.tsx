import type { Album, AlbumDetail, FavoriteTrack, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useToasts } from '../lib/toast';
import { usePlayer } from '../player/store';
import { FavoritesPage } from './Favorites';

const MEZZANINE = { id: 70, title: 'Mezzanine', artistId: 7, artistName: 'Massive Attack' } as Album;
const song = { id: 8, fileId: 8, recordingId: 'r8', title: 'Angel', albumId: 70, artistId: 7, duration: 380, streamUrl: '/s/8' } as Track;
const gloryBox = { id: 9, fileId: 9, recordingId: 'r9', title: 'Glory Box', albumId: 80, artistId: 8, artistName: 'Portishead', albumTitle: 'Dummy', duration: 306, streamUrl: '/s/9' } as Track;

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
  vi.spyOn(api, 'favoriteRecommendations').mockResolvedValue({ owned: [], missing: [], seedCount: 0 });
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useToasts.setState({ toasts: [] });
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
    // Nothing to suggest songs like.
    expect(screen.queryByRole('region', { name: 'Songs like these' })).toBeNull();
    expect(api.favoriteRecommendations).not.toHaveBeenCalled();
  });

  it('suggests songs like the favorites; Add hearts one, which leaves the suggestions for the list', async () => {
    let hearted: FavoriteTrack[] = [{ ...song, favoritedAt: '2026-11-01T12:00:00.000Z' }];
    vi.spyOn(api, 'favorites').mockImplementation(async () => hearted);
    vi.spyOn(api, 'addFavorite').mockImplementation(async () => {
      hearted = [{ ...gloryBox, favoritedAt: '2026-11-07T12:00:00.000Z' }, ...hearted];
    });
    const recommendations = vi
      .spyOn(api, 'favoriteRecommendations')
      .mockResolvedValue({
        owned: [{ recordingId: 'mb-glory-box', title: 'Glory Box', artistName: 'Portishead', albumTitle: 'Dummy', because: 'Angel', track: gloryBox, artistId: 8 }],
        missing: [],
        seedCount: 1,
      });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    view();

    const section = await screen.findByRole('region', { name: 'Songs like these' });
    expect(recommendations).toHaveBeenCalledWith(0);
    fireEvent.click(await within(section).findByRole('button', { name: 'Add Glory Box to Favorites' }));
    await waitFor(() => expect(api.addFavorite).toHaveBeenCalledWith('r9', undefined));
    await waitFor(() => expect(within(section).queryByRole('button', { name: 'Add Glory Box to Favorites' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Remove “Glory Box” from Favorites' })).toBeTruthy();
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toContain('Added “Glory Box” to Favorites'));

    await act(async () => fireEvent.click(within(section).getByRole('button', { name: 'Other suggestions' })));
    expect(recommendations).toHaveBeenLastCalledWith(1);
  });

  it('offers Feeling lucky when nothing has been heard yet', async () => {
    vi.spyOn(api, 'recentAlbums').mockResolvedValue([]);
    view();
    expect(await screen.findByRole('button', { name: 'Feeling lucky' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jump back in' })).toBeNull();
  });
});
