import type { ListeningStats, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePlayer } from '../player/store';
import { reviewYear } from './Home';
import { minutesLabel, StatsPage } from './Stats';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const track = (id: number) => ({ id, fileId: id, recordingId: `r${id}`, title: `Song ${id}`, artistName: 'Artist', albumId: 1 }) as Track;
const stats: ListeningStats = {
  range: '2026',
  to: '2027-01-01T00:00:00.000Z',
  minutes: 1234,
  plays: 300,
  songs: 120,
  artists: 40,
  days: 90,
  newArtists: 12,
  longestStreak: 9,
  topArtists: [{ artist: { id: 7, name: 'Portishead' } as never, plays: 50, minutes: 200 }],
  topAlbums: [],
  topTracks: [
    { track: track(1), plays: 20 },
    { track: track(2), plays: 15 },
  ],
  topGenres: [{ genre: 'trip hop', minutes: 300 }],
  hours: Array.from({ length: 24 }, (_, h) => (h === 21 ? 120 : 5)),
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  months: Array(12).fill(10),
  firstSong: { track: track(2), at: '2026-01-01T10:00:00Z' },
  years: [2026, 2025],
};

describe('Your listening', () => {
  it('shows a year in review: minutes, artist of the year, top songs to play, when you listen', async () => {
    vi.spyOn(api, 'stats').mockResolvedValue(stats);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/stats?range=2026']}>
          <StatsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Your artist of the year')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your 2026' })).toBeTruthy();
    expect(api.stats).toHaveBeenCalledWith('2026');
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '2025' })).toBeTruthy();
    expect(screen.getByText('By month')).toBeTruthy();
    expect(screen.getAllByText(/Most:/)[0]!.textContent).toContain('2 h');
    fireEvent.click(screen.getByRole('button', { name: /Play them/ }));
    expect(usePlayer.getState().queue.map((t) => t.id)).toEqual([1, 2]);
    expect(usePlayer.getState().source).toEqual({ label: 'Your top songs of 2026', href: '/settings/listening?range=2026' });
  });

  it('formats minutes, and shows the year in review on Home in December and January', () => {
    expect(minutesLabel(45)).toBe('45 min');
    expect(minutesLabel(125)).toBe('2 h 5 min');
    expect(reviewYear(new Date(2026, 11, 3))).toBe(2026);
    expect(reviewYear(new Date(2027, 0, 20))).toBe(2026);
    expect(reviewYear(new Date(2026, 5, 1))).toBeUndefined();
  });
});
