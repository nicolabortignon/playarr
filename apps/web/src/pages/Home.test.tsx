import type { Account } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { Greeting, shelfArtists } from './Home';

afterEach(() => {
  cleanup();
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
  it('greets the account by name, beside its avatar, which opens Account and Settings', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(account());
    const router = renderGreeting();
    expect(await screen.findByRole('heading', { level: 1, name: 'Hi, Alex.' })).toBeTruthy();
    const avatar = screen.getByRole('button', { name: 'Account and settings' });
    expect(avatar.textContent).toBe('A');
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account' }));
    expect(router.state.location.pathname).toBe('/settings/accounts');
  });

  it('uses the username when the account has no name', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(account({ name: '  ' }));
    renderGreeting();
    expect(await screen.findByRole('heading', { level: 1, name: 'Hi, alex.' })).toBeTruthy();
  });

  it('just says hello, with no avatar, before anyone has signed in', async () => {
    vi.spyOn(api, 'me').mockRejectedValue(new ApiError('Nobody is signed in', 401));
    renderGreeting();
    expect(await screen.findByRole('heading', { level: 1, name: 'Hi there.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Account and settings' })).toBeNull();
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
