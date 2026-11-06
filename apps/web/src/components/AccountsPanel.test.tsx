import type { Account, ServerInfo, SourceInfo } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { AccountsPanel } from './AccountsPanel';

const SERVER: ServerInfo = { id: 'u', name: 'NAS', version: '0.7.0', minAppVersion: '1.0.0', setup: false };
const NICOLA: Account = { id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };
const CC = { id: 2, kind: 'folder', name: 'Creative Commons', position: 1, enabled: true } as SourceInfo;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
});

const view = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccountsPanel />
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe('AccountsPanel', () => {
  it('lets an admin add an account and shows its setup code and link', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'me').mockResolvedValue(NICOLA);
    vi.spyOn(api, 'accounts').mockResolvedValue([
      { ...NICOLA, plays: 1234, playlists: 3 },
      { ...SAM, plays: 1, playlists: 0 },
    ]);
    vi.spyOn(api, 'sessions').mockResolvedValue([]);
    vi.spyOn(api, 'sources').mockResolvedValue({ sources: [CC], canEdit: true });
    const reviewer: Account = { id: 3, username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [2], hasPassword: false };
    const create = vi.spyOn(api, 'createAccount').mockResolvedValue({
      account: reviewer,
      setup: { code: 'ABCD2345', link: 'http://nas:4000/redeem?code=ABCD2345', expiresAt: '2026-11-10T10:00:00Z' },
    });
    view();
    expect(await screen.findByText('Sam')).toBeTruthy();
    expect(screen.getByText('1,234 songs played · 3 playlists')).toBeTruthy();
    expect(screen.getByText('1 song played · 0 playlists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add account/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'App Review' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByLabelText('Can request albums')); // on by default for new accounts: off
    fireEvent.click(screen.getByLabelText('Appearance')); // may change Playback on their devices, not Appearance
    fireEvent.click(screen.getByLabelText('Only these sources'));
    fireEvent.click(await screen.findByLabelText('Creative Commons'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [2], locked: ['appearance'] }));
    expect(await screen.findByText('ABCD2345')).toBeTruthy();
    expect((screen.getByLabelText('Setup link') as HTMLInputElement).value).toBe('http://nas:4000/redeem?code=ABCD2345');
  });

  it('shows a member their own name and devices, not everyone', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'me').mockResolvedValue(SAM);
    const accounts = vi.spyOn(api, 'accounts');
    vi.spyOn(api, 'sessions').mockResolvedValue([
      { id: 7, device: 'Safari on iPhone', platform: 'web', createdAt: '2026-11-03T10:00:00Z', lastSeenAt: '2026-11-03T11:00:00Z', current: true },
      { id: 8, device: 'Playarr on iPad', platform: 'ios', createdAt: '2026-11-02T10:00:00Z', lastSeenAt: '2026-11-02T11:00:00Z', current: false },
    ]);
    const end = vi.spyOn(api, 'endSession').mockResolvedValue([]);
    const rename = vi.spyOn(api, 'updateAccount').mockResolvedValue({ ...SAM, name: 'Samantha' });
    view();
    expect(await screen.findByText('Safari on iPhone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add account/ })).toBeNull();
    expect(accounts).not.toHaveBeenCalled();
    // Signing a device out asks first, naming it.
    fireEvent.click(screen.getByRole('button', { name: 'Sign out Playarr on iPad' }));
    const ask = await screen.findByRole('dialog', { name: 'Sign out Playarr on iPad?' });
    expect(end).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(end).toHaveBeenCalledWith(2, 8));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Samantha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith(2, { name: 'Samantha' }));
  });

  it('offers to set up a server nobody has set up', async () => {
    vi.spyOn(api, 'server').mockResolvedValue({ ...SERVER, setup: true });
    vi.spyOn(api, 'me').mockRejectedValue(new Error('Nobody is signed in'));
    view();
    expect((await screen.findByRole('link', { name: 'Set up the owner’s account' })).getAttribute('href')).toBe('/setup');
  });
});
