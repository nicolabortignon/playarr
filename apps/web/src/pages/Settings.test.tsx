import type { Account } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useUI } from '../lib/ui';
import { ListeningMoved } from '../routes';
import { SettingsPage } from './Settings';

const ALEX: Account = { id: 1, username: 'alex', name: 'Alex', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { ...ALEX, id: 2, username: 'sam', name: 'Sam', role: 'member' };

/** A window this wide: a phone's 390, the desktop layout's narrowest 768, the iPad's 1032 (each min-width query answered). */
const width = (px: number) =>
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: !!min && px >= Number(min[1]), media: query, addEventListener() {}, removeEventListener() {} };
  });
const PHONE = 390;
const IPAD = 1032;

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
    width(PHONE);
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
    width(PHONE);
    const router = view('/settings');
    fireEvent.click(await screen.findByRole('link', { name: 'Appearance' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
    expect(screen.getByText('These settings are for this device.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('takes a panel opened from elsewhere back to the list', async () => {
    width(PHONE);
    const router = view('/settings/appearance');
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('link', { name: 'Playback' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('gives a member their account’s settings, then the server’s they can only read', async () => {
    width(PHONE);
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
  /** The column's groups and their panels, as it shows them. */
  const column = () =>
    within(screen.getByRole('navigation', { name: 'Settings' }))
      .getAllByRole('group')
      .map((group) => [group.getAttribute('aria-labelledby') && document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent, within(group).getAllByRole('link').map((l) => l.textContent)]);

  it('puts every panel in a column beside the open one, in the list’s groups, the first open and marked', async () => {
    width(IPAD);
    view('/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(column()).toEqual([
      ['This device', ['Playback', 'Appearance']],
      ['Server', ['Sources', 'Accounts', 'Made for you', 'Analysis', 'Requests', 'Updates']],
    ]);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Playback' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getAllByRole('link').filter((l) => l.getAttribute('aria-current'))).toHaveLength(1);
    // Whom the panel is for, above it; the phone's list of groups isn't there too.
    expect(screen.getByText('These settings are for this device.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'This device' })).toBeNull();
  });

  it('reaches every panel from the column, marking the one open', async () => {
    width(IPAD);
    const router = view('/settings');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    for (const name of ['Appearance', 'Sources', 'Accounts', 'Made for you', 'Analysis', 'Requests', 'Updates', 'Playback']) {
      fireEvent.click(within(nav).getByRole('link', { name }));
      expect(within(nav).getByRole('link', { name }).getAttribute('aria-current')).toBe('page');
      expect(router.state.location.pathname).toBe(`/settings/${{ 'Made for you': 'mixes' }[name] ?? name.toLowerCase()}`);
    }
  });

  it('never scrolls sideways: no strip, no arrows', async () => {
    width(IPAD);
    view('/settings/updates');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    for (const el of [nav, ...nav.querySelectorAll('*')]) expect(el.className).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(screen.queryByRole('button', { name: 'More settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Earlier settings' })).toBeNull();
  });

  it('tells a member, in the column, what they can only read', async () => {
    width(IPAD);
    view('/settings', SAM);
    await screen.findByRole('group', { name: 'Your account' });
    expect(column()).toEqual([
      ['This device', ['Playback', 'Appearance']],
      ['Your account', ['Accounts', 'Made for you']],
      ['Server', ['Sources', 'Analysis', 'Requests', 'Updates']],
    ]);
    expect(within(screen.getByRole('group', { name: 'Server' })).getByText('Only an admin can change these.')).toBeTruthy();
  });

  it('is the list again where the page is too narrow for two columns', async () => {
    width(900);
    view('/settings');
    expect(await screen.findByRole('region', { name: 'This device' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  });

  it('is the list again beside the queue column, until the window has room for both', async () => {
    useUI.setState({ sideColumn: 'queue' });
    width(1300);
    view('/settings');
    expect(await screen.findByRole('region', { name: 'This device' })).toBeTruthy();
    cleanup();
    width(1440);
    view('/settings');
    expect(await screen.findByRole('navigation', { name: 'Settings' })).toBeTruthy();
    useUI.setState({ sideColumn: null });
  });
});

describe('Your listening', () => {
  it('opens from its old Settings links, with the period chosen', async () => {
    width(IPAD);
    const router = view('/settings/listening?range=2025');
    expect(await screen.findByText('your listening')).toBeTruthy();
    expect(router.state.location.pathname + router.state.location.search).toBe('/stats?range=2025');
  });
});
