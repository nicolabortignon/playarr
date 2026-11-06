import type { Account, AlbumRequest, HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useToasts } from '../lib/toast';
import { RequestsPage } from './Requests';

const NO_LIDARR: HealthStatus = { ok: true, media: { source: 'local', ok: true }, requests: false };
const WITH_LIDARR: HealthStatus = { ...NO_LIDARR, lidarr: { ok: true, version: '2.0' }, requests: true };
const ALEX: Account = { id: 1, username: 'alex', name: 'Alex', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: true, sources: null, hasPassword: true };
const OK_COMPUTER: AlbumRequest = {
  mbid: 'b1392450-e666-3926-a536-22c65f834433',
  title: 'OK Computer',
  artistName: 'Radiohead',
  requestedAt: '2026-11-05T10:00:00Z',
  availability: { state: 'available', albumId: 3 },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useToasts.setState({ toasts: [] });
});

function view({ health, me, requests = [] }: { health: HealthStatus; me: Account | Promise<Account>; requests?: AlbumRequest[] }) {
  vi.spyOn(api, 'health').mockResolvedValue(health);
  vi.spyOn(api, 'me').mockReturnValue(Promise.resolve(me));
  vi.spyOn(api, 'requests').mockResolvedValue(requests);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <RequestsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Requests', () => {
  it('tells an admin on a server without Lidarr that requests need a Lidarr source, and where to add one', async () => {
    view({ health: NO_LIDARR, me: ALEX });
    expect(await screen.findByText('Requests need a Lidarr source.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add Lidarr' }).getAttribute('href')).toBe('/settings/sources');
    // Nothing promises a Request button that isn't there.
    expect(screen.queryByText(/asked Lidarr to find/)).toBeNull();
    expect(screen.queryByText(/press Request/)).toBeNull();
  });

  it('tells anyone else that requests aren’t set up on this server, with nothing to press', async () => {
    view({ health: NO_LIDARR, me: SAM });
    expect(await screen.findByText('Requests aren’t set up on this server.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Requests need a Lidarr source.')).toBeNull();
  });

  it('holds the page’s shape while it learns who’s asking, rather than showing nothing', async () => {
    let signedIn!: (account: Account) => void;
    view({ health: NO_LIDARR, me: new Promise<Account>((resolve) => (signedIn = resolve)) });
    // The list and the server's health have answered; the account hasn't.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getByLabelText('Loading requests')).toBeTruthy();
    act(() => signedIn(SAM));
    expect(await screen.findByText('Requests aren’t set up on this server.')).toBeTruthy();
    expect(screen.queryByLabelText('Loading requests')).toBeNull();
  });

  it('says how to ask for an album where requests work', async () => {
    view({ health: WITH_LIDARR, me: SAM });
    expect(await screen.findByText('Ask for an album you don’t have.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search' }).getAttribute('href')).toBe('/search');
    expect(screen.getByText(/Albums you asked Lidarr to find/)).toBeTruthy();
  });

  it('takes a request off the list at once; Undo brings it back, and the server forgets it only once the Undo has gone', async () => {
    const forget = vi.spyOn(api, 'removeRequest').mockResolvedValue();
    view({ health: WITH_LIDARR, me: ALEX, requests: [OK_COMPUTER] });
    const remove = () => fireEvent.click(screen.getByRole('button', { name: 'Remove OK Computer from this list' }));
    await screen.findByRole('button', { name: 'Remove OK Computer from this list' });

    remove();
    expect(screen.queryByRole('button', { name: 'Remove OK Computer from this list' })).toBeNull();
    const [toast] = useToasts.getState().toasts;
    expect(toast!.message).toBe('Removed “OK Computer” from Requests');
    act(() => useToasts.getState().act(toast!.id));
    expect(await screen.findByRole('button', { name: 'Remove OK Computer from this list' })).toBeTruthy();
    expect(forget).not.toHaveBeenCalled();

    // Again, and this time the Undo goes by.
    remove();
    act(() => useToasts.getState().dismiss(useToasts.getState().toasts[0]!.id));
    await waitFor(() => expect(forget).toHaveBeenCalledWith(OK_COMPUTER.mbid));
  });
});
