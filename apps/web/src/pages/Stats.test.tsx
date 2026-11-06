import type { ListeningStats, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { usePlayer } from '../player/store';
import { reviewYear } from './Home';
import { CountUp, isNewRecord, minutesLabel, StatsPage } from './Stats';

beforeEach(() => {
  usePrefs.setState({ motion: 'full' });
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function view(range = '2026') {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/stats?range=${range}`]}>
        <StatsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

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
  currentStreak: 0,
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
    // A top song shows its plays where other lists show the length, and plays from there when pressed.
    expect(screen.getAllByText('20 plays').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play Song 2' }));
    expect(usePlayer.getState().queue[usePlayer.getState().order[usePlayer.getState().pos]!]!.id).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: /Play them/ }));
    expect(usePlayer.getState().queue.map((t) => t.id)).toEqual([1, 2]);
    expect(usePlayer.getState().source).toEqual({ label: 'Your top songs of 2026', href: '/stats?range=2026' });
  });

  it('formats minutes, and shows the year in review on Home in December and January', () => {
    expect(minutesLabel(45)).toBe('45 min');
    expect(minutesLabel(125)).toBe('2 h 5 min');
    expect(reviewYear(new Date(2026, 11, 3))).toBe(2026);
    expect(reviewYear(new Date(2027, 0, 20))).toBe(2026);
    expect(reviewYear(new Date(2026, 5, 1))).toBeUndefined();
  });
});

describe('Your listening’s little rituals', () => {
  it('counts the headline number up as the page opens, landing on the real one', async () => {
    render(<CountUp value={1792} />);
    // The real number holds its place and is what's read out; the count runs over it.
    const real = screen.getByText('1,792');
    expect(real.className).toContain('text-transparent');
    expect(real.parentElement!.textContent).not.toBe('1,7921,792');
    await waitFor(() => expect(real.className).not.toContain('text-transparent'), { timeout: 3000 });
    expect(real.parentElement!.textContent).toBe('1,792');
  });

  it('shows the number at once under Reduce Motion', () => {
    usePrefs.setState({ motion: 'reduce' });
    render(<CountUp value={1792} />);
    expect(screen.getByText('1,792').className).not.toContain('text-transparent');
    expect(screen.getByText('1,792').parentElement!.textContent).toBe('1,792');
  });

  it('flags a new longest streak: the one going on, when it’s more than a day', () => {
    expect(isNewRecord({ longestStreak: 9, currentStreak: 9 })).toBe(true);
    expect(isNewRecord({ longestStreak: 9, currentStreak: 3 })).toBe(false);
    expect(isNewRecord({ longestStreak: 1, currentStreak: 1 })).toBe(false);
    // Servers before it don't send the streak going on.
    expect(isNewRecord({ longestStreak: 9 })).toBe(false);
  });

  it('puts the flag on the Longest streak tile', async () => {
    vi.spyOn(api, 'stats').mockResolvedValue({ ...stats, range: 'month', currentStreak: 9 });
    view('month');
    expect(await screen.findByText('New record')).toBeTruthy();
    cleanup();
    vi.spyOn(api, 'stats').mockResolvedValue({ ...stats, range: 'month', currentStreak: 4 });
    view('month');
    expect(await screen.findByText('Longest streak')).toBeTruthy();
    expect(screen.queryByText('New record')).toBeNull();
  });

  it('opens a year in review like a sleeve sliding out, and keeps it still under Reduce Motion', async () => {
    vi.spyOn(api, 'stats').mockResolvedValue(stats);
    view();
    expect(await screen.findByText('Your artist of the year')).toBeTruthy();
    expect(screen.getByText('Year in review').closest('[data-sleeve]')).not.toBeNull();
    cleanup();
    usePrefs.setState({ motion: 'reduce' });
    view();
    expect(await screen.findByText('Your artist of the year')).toBeTruthy();
    expect(document.querySelector('[data-sleeve]')).toBeNull();
  });

  it('says no spins in this period yet, with Feeling lucky', async () => {
    vi.spyOn(api, 'stats').mockResolvedValue({ ...stats, range: 'month', plays: 0, minutes: 0 });
    view('month');
    // docs/design.md, The lines: Stats.
    expect(await screen.findByText('No spins in this period yet.')).toBeTruthy();
    expect(screen.getByText('A song counts once it’s heard for 30 seconds.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Feeling lucky' })).toBeTruthy();
  });
});
