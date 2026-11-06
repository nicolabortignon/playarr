import type { FavoriteTrack, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useFavorites } from '../lib/queries';
import { useToasts } from '../lib/toast';
import { FavoriteButton } from './FavoriteButton';

const song = (n: number) => ({ id: n, fileId: n, recordingId: `rec-${n}`, albumId: n, title: `Song ${n}`, streamUrl: `/s/${n}` }) as Track;
const favorite = (n: number, favoritedAt: string): FavoriteTrack => ({ ...song(n), favoritedAt });
/** Favorited in January, before Song 2 in March: it's second in Favorites, newest first. */
const JANUARY = '2026-01-01T00:00:00.000Z';
const FAVORITES = [favorite(2, '2026-03-01T00:00:00.000Z'), favorite(1, JANUARY)];

/** Favorites as the page lists them: un-hearting one takes it out of the list. */
function Hearts() {
  const { data = [] } = useFavorites();
  return data.map((t) => <FavoriteButton key={t.recordingId} track={t} />);
}

let client: QueryClient;

function renderAt(path: string, element: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['favorites'], FAVORITES);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter([{ path, element }], { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

const order = () => client.getQueryData<FavoriteTrack[]>(['favorites'])!.map((t) => t.recordingId);
const heart = (title: string) => screen.getByRole('button', { name: new RegExp(`“${title}”`) });

beforeEach(() => {
  // The server answers with what the page already shows.
  vi.spyOn(api, 'favorites').mockImplementation(async () => client.getQueryData<FavoriteTrack[]>(['favorites']) ?? []);
  vi.spyOn(api, 'removeFavorite').mockResolvedValue();
  vi.spyOn(api, 'addFavorite').mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useToasts.setState({ toasts: [] });
});

describe('FavoriteButton', () => {
  it('puts a song hearted again back where it was in Favorites, not at the top', async () => {
    renderAt('/albums/1', <FavoriteButton track={song(1)} />);
    fireEvent.click(heart('Song 1'));
    await waitFor(() => expect(api.removeFavorite).toHaveBeenCalledWith('rec-1'));
    expect(order()).toEqual(['rec-2']);
    fireEvent.click(heart('Song 1'));
    await waitFor(() => expect(api.addFavorite).toHaveBeenCalledWith('rec-1', JANUARY));
    expect(order()).toEqual(['rec-2', 'rec-1']);
    // Off Favorites, the song wasn't taken out of anything in view: no toast.
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it('on Favorites, says the song was removed, with Undo putting it back where it was', async () => {
    renderAt('/favorites', <Hearts />);
    fireEvent.click(heart('Song 1'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Song 1/ })).toBeNull());
    const [toast] = useToasts.getState().toasts;
    expect(toast?.message).toBe('Removed “Song 1” from Favorites');
    await act(async () => toast!.action!.run());
    await waitFor(() => expect(api.addFavorite).toHaveBeenCalledWith('rec-1', JANUARY));
    expect(order()).toEqual(['rec-2', 'rec-1']);
    expect(heart('Song 1')).toBeTruthy();
  });

  it('hearts a song for the first time as of now', async () => {
    renderAt('/albums/3', <FavoriteButton track={song(3)} />);
    fireEvent.click(heart('Song 3'));
    await waitFor(() => expect(api.addFavorite).toHaveBeenCalledWith('rec-3', undefined));
    expect(order()[0]).toBe('rec-3');
  });
});
