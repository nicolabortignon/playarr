import type { Account } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { ListeningMoved } from '../routes';
import { SettingsPage } from './Settings';

const ALEX: Account = { id: 1, username: 'alex', name: 'Alex', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { ...ALEX, id: 2, username: 'sam', name: 'Sam', role: 'member' };

/** A window as wide as a phone, or wider (the desktop layout starts at 768). */
const width = (wide: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 768px)' && wide, media: query, addEventListener() {}, removeEventListener() {} }));

function view(path: string, me: Account = ALEX) {
  vi.spyOn(api, 'me').mockResolvedValue(me);
  const router = createMemoryRouter(
    [
      { path: '/settings/listening', element: <ListeningMoved /> },
      { path: '/settings/:panel?', element: <SettingsPage /> },
      { path: '/stats', element: <p>your listening</p> },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Each group's name and its rows, as the phone's list shows them. */
const groups = () =>
  screen.getAllByRole('region').map((group) => [group.getAttribute('aria-label'), within(group).getAllByRole('link').map((row) => row.textContent)]);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Settings on a phone', () => {
  it('is a list in groups, as on iOS, without tabs', async () => {
    width(false);
    view('/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(groups()).toEqual([
      ['This device', ['Playback', 'Appearance']],
      ['Server', ['Sources', 'Accounts', 'Made for you', 'Analysis', 'Requests', 'Updates']],
    ]);
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
    // Your listening isn't a setting any more.
    expect(screen.queryByText('Your listening')).toBeNull();
  });

  it('opens a row’s panel under its own name, and goes back to the list', async () => {
    width(false);
    const router = view('/settings');
    fireEvent.click(await screen.findByRole('link', { name: 'Appearance' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
    expect(screen.getByText('These settings are for this device.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('takes a panel opened from elsewhere back to the list', async () => {
    width(false);
    const router = view('/settings/appearance');
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('link', { name: 'Playback' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('gives a member their account’s settings, then the server’s they can only read', async () => {
    width(false);
    view('/settings', SAM);
    await screen.findByRole('region', { name: 'Your account' });
    expect(groups()).toEqual([
      ['This device', ['Playback', 'Appearance']],
      ['Your account', ['Accounts', 'Made for you']],
      ['Server', ['Sources', 'Analysis', 'Requests', 'Updates']],
    ]);
    expect(screen.getByText('Only an admin can change these.')).toBeTruthy();
  });
});

describe('Settings on a wide screen', () => {
  it('keeps the tabs, in the list’s order, the first open', async () => {
    width(true);
    view('/settings');
    const tabs = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(tabs).getAllByRole('link').map((t) => t.textContent)).toEqual([
      'Playback',
      'Appearance',
      'Sources',
      'Accounts',
      'Made for you',
      'Analysis',
      'Requests',
      'Updates',
    ]);
    expect(within(tabs).getByRole('link', { name: 'Playback' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('region', { name: 'This device' })).toBeNull();
  });

  it('hints at the tabs out of sight, at either end', async () => {
    width(true);
    view('/settings/appearance');
    const tabs = await screen.findByRole('navigation', { name: 'Settings' });
    const size = { clientWidth: 300, scrollWidth: 800, scrollLeft: 0 };
    for (const key of Object.keys(size) as (keyof typeof size)[]) Object.defineProperty(tabs, key, { configurable: true, get: () => size[key] });
    fireEvent.scroll(tabs);
    expect(screen.getByRole('button', { name: 'More settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Earlier settings' })).toBeNull();
    size.scrollLeft = 500;
    fireEvent.scroll(tabs);
    expect(screen.getByRole('button', { name: 'Earlier settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More settings' })).toBeNull();
  });
});

describe('Your listening', () => {
  it('opens from its old Settings links, with the period chosen', async () => {
    width(true);
    const router = view('/settings/listening?range=2025');
    expect(await screen.findByText('your listening')).toBeTruthy();
    expect(router.state.location.pathname + router.state.location.search).toBe('/stats?range=2025');
  });
});
