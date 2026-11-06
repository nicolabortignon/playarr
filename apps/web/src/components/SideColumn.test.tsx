import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useUI } from '../lib/ui';
import { usePlayer } from '../player/store';
import { SideColumn } from './SideColumn';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 200, streamUrl: `/s/${id}` }) as Track;

const column = () => screen.queryByRole('complementary', { name: 'Queue and lyrics' });

beforeEach(() => {
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  vi.spyOn(api, 'lyrics').mockResolvedValue(null);
  usePlayer.setState({ queue: [1, 2, 3].map(track), order: [0, 1, 2], pos: 0, playing: true });
  useUI.setState({ sideColumn: 'queue' });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SideColumn />
      </MemoryRouter>
    </QueryClientProvider>,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the queue and lyrics column', () => {
  it('shows the queue: the song playing, then Up next, laid out for its width', () => {
    const queue = column()!;
    expect(within(queue).getByText('Now playing')).toBeTruthy();
    expect(within(queue).getByRole('button', { name: 'Play Song 2' })).toBeTruthy();
    expect(within(queue).getByRole('button', { name: 'Drag to reorder Song 3' })).toBeTruthy();
    // As on a phone: no heart beside each coming song, its length under its title.
    const row = within(queue).getByRole('button', { name: 'Play Song 2' }).closest('li')!;
    expect(within(row).getByRole('button', { name: 'Add “Song 2” to Favorites' }).className).toContain('hidden');
    expect(within(queue).getByRole('button', { name: 'Save as playlist' })).toBeTruthy();
  });

  it('switches to the words of the song playing, and closes', async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Lyrics' }));
    expect(useUI.getState().sideColumn).toBe('lyrics');
    expect(await screen.findByText('No lyrics found for this song.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close queue and lyrics' }));
    expect(useUI.getState().sideColumn).toBeNull();
    expect(column()).toBeNull();
  });
});
