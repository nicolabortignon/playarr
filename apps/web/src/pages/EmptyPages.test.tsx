import type { Account } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { AlbumsPage } from './Albums';
import { ArtistsPage } from './Artists';
import { MixesPage } from './Mixes';

// docs/design.md, Empty, loading and error → The lines: the library's empty pages, word for word (iOS's PageLines says the same).

const me = (role: Account['role']) => ({ id: 1, username: 'alex', name: 'Alex', role, canRequest: true, sources: null, hasPassword: true }) as Account;
const view = (page: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('an empty library', () => {
  it('tells an admin their crates are empty, and how to add music', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(me('admin'));
    vi.spyOn(api, 'albums').mockResolvedValue([]);
    view(<AlbumsPage />);
    expect(await screen.findByText('Your crates are empty.')).toBeTruthy();
    expect(screen.getByText('Add Lidarr or a folder of music, and it shows up here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add music' }).getAttribute('href')).toBe('/settings/sources');
  });

  it('tells a member that music shows up once an admin adds some, without a button that leads nowhere', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(me('member'));
    vi.spyOn(api, 'artists').mockResolvedValue([]);
    view(<ArtistsPage />);
    expect(await screen.findByText('Music shows up here once an admin adds some.')).toBeTruthy();
    expect(screen.getByText('Nobody on the roster yet.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add music' })).toBeNull();
  });

  it('says the mixes are on their way, with Feeling lucky', async () => {
    vi.spyOn(api, 'mixes').mockResolvedValue([]);
    view(<MixesPage />);
    expect(await screen.findByText('Your mixes are on their way.')).toBeTruthy();
    expect(screen.getByText('They appear as you listen, and as Playarr learns your library.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Feeling lucky' })).toBeTruthy();
  });
});
