import type { Account } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { Greeting, greeting, partOfDay, shelfArtists } from './Home';

beforeEach(() => {
  // A morning: only the clock's date is faked, so queries' timers still run.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 6, 8, 30));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const account = (over: Partial<Account> = {}): Account => ({
  id: 1,
  username: 'alex',
  name: 'Alex',
  role: 'admin',
  canRequest: true,
  sources: null,
  hasPassword: true,
  ...over,
});

function renderGreeting() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <Greeting /> },
      { path: '/settings/:panel?', element: <p>settings</p> },
      { path: '/stats', element: <p>your listening</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('Home greeting', () => {
  it('greets the account by name and the time of day, beside its avatar, which opens Account and Settings', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(account());
    const router = renderGreeting();
    expect(await screen.findByRole('heading', { level: 1, name: 'Morning, Alex.' })).toBeTruthy();
    const avatar = screen.getByRole('button', { name: 'Account and settings' });
    expect(avatar.textContent).toBe('A');
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }));
    expect(router.state.location.pathname).toBe('/settings/accounts');
  });

  it('opens Your listening from the avatar’s menu, now that it isn’t a setting', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(account());
    const router = renderGreeting();
    fireEvent.click(await screen.findByRole('button', { name: 'Account and settings' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Account', 'Your listening', 'Settings']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Your listening' }));
    expect(router.state.location.pathname).toBe('/stats');
  });

  it('uses the username when the account has no name', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(account({ name: '  ' }));
    renderGreeting();
    expect(await screen.findByRole('heading', { level: 1, name: 'Morning, alex.' })).toBeTruthy();
  });

  it('just says hello, with no avatar, before anyone has signed in', async () => {
    vi.spyOn(api, 'me').mockRejectedValue(new ApiError('Nobody is signed in', 401));
    renderGreeting();
    expect(await screen.findByRole('heading', { level: 1, name: 'Hi there.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Account and settings' })).toBeNull();
  });

  it('greets late at night after ten', async () => {
    vi.setSystemTime(new Date(2026, 10, 6, 23, 15));
    vi.spyOn(api, 'me').mockResolvedValue(account());
    renderGreeting();
    expect(await screen.findByRole('heading', { level: 1, name: 'Late night, Alex.' })).toBeTruthy();
  });

  it('changes at the hours Vibes of the hour changes mood (5, 17, 22), with the day split at noon', () => {
    const at = (hours: number[]) => hours.map(partOfDay);
    expect(at([5, 9, 11])).toEqual(['Morning', 'Morning', 'Morning']);
    expect(at([12, 16])).toEqual(['Afternoon', 'Afternoon']);
    expect(at([17, 21])).toEqual(['Evening', 'Evening']);
    expect(at([22, 23, 0, 4])).toEqual(['Late night', 'Late night', 'Late night', 'Late night']);
    expect(greeting(account(), 18)).toBe('Evening, Alex.');
    expect(greeting(account({ name: '' }), 13)).toBe('Afternoon, alex.');
    expect(greeting(undefined, 13)).toBe('Hi there.');
  });
});

describe('shelfArtists', () => {
  it('shows the artists of the latest albums first, then the biggest, never the whole roster', () => {
    const artists = Array.from({ length: 300 }, (_, i) => ({ id: i, albumCount: i % 7 }));
    const shelf = shelfArtists(artists, [{ artistId: 250 }, { artistId: 3 }, { artistId: 250 }]);
    expect(shelf).toHaveLength(20);
    expect(shelf.slice(0, 2).map((a) => a.id)).toEqual([250, 3]);
    expect(shelf.slice(2).every((a) => a.albumCount === 6)).toBe(true);
  });
});
