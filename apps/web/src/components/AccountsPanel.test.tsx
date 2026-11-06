import type { Account, ServerInfo, SourceInfo } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { INVITES_KEY, inviteFor, rememberInvite } from '../lib/invites';
import { queryClient } from '../lib/queryClient';
import { useToasts } from '../lib/toast';
import { AccountsPanel } from './AccountsPanel';

const SERVER: ServerInfo = { id: 'u', name: 'NAS', version: '0.7.0', minAppVersion: '1.0.0', setup: false };
const NICOLA: Account = { id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };
const CC = { id: 2, kind: 'folder', name: 'Creative Commons', position: 1, enabled: true } as SourceInfo;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
  localStorage.removeItem(INVITES_KEY);
  useToasts.setState({ toasts: [] });
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

describe('AccountsPanel, invites and actions', () => {
  const JO: Account = { id: 3, username: 'jo', name: 'Jo', role: 'member', canRequest: true, sources: null, hasPassword: false };
  const LINK = 'http://nas:4000/redeem?code=JOJO2345';
  const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  function everyone() {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'me').mockResolvedValue(NICOLA);
    vi.spyOn(api, 'accounts').mockResolvedValue([
      { ...NICOLA, plays: 1234, playlists: 3 },
      { ...SAM, plays: 1, playlists: 0 },
      { ...JO, plays: 0, playlists: 0 },
    ]);
    vi.spyOn(api, 'sessions').mockResolvedValue([]);
    vi.spyOn(api, 'sources').mockResolvedValue({ sources: [CC], canEdit: true });
    view();
  }
  const row = async (name: string) => (await screen.findByText(name, { selector: 'li > div > div > div' })).closest('li')!;
  const clipboard = (writeText: (text: string) => Promise<void>) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const menuItems = () => within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);

  it('shows someone invited who never set up as an invite, not an account with nothing played', async () => {
    everyone();
    const jo = await row('Jo');
    expect(within(jo).getByText('Invited · not set up yet')).toBeTruthy();
    expect(within(jo).queryByText(/songs? played/)).toBeNull();
    expect(within(jo).getByRole('button', { name: 'Copy invite link' })).toBeTruthy();
    expect(within(jo).getByRole('button', { name: 'New code' })).toBeTruthy();
    const sam = await row('Sam');
    expect(within(sam).queryByText('Invited · not set up yet')).toBeNull();
    expect(within(sam).queryByRole('button', { name: 'Copy invite link' })).toBeNull();
  });

  it('copies the invite this device made, as it was', async () => {
    rememberInvite(3, { code: 'JOJO2345', link: LINK, expiresAt: nextWeek() });
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const reset = vi.spyOn(api, 'resetAccount');
    everyone();
    fireEvent.click(within(await row('Jo')).getByRole('button', { name: 'Copy invite link' }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    await waitFor(() => expect(useToasts.getState().toasts[0]?.message).toBe('Copied Jo’s invite link'));
    expect(reset).not.toHaveBeenCalled();
  });

  it('makes a new invite link, after saying the old one stops working, when this device has none to copy', async () => {
    const reset = vi.spyOn(api, 'resetAccount').mockResolvedValue({ code: 'NEWC0DE2', link: 'http://nas:4000/redeem?code=NEWC0DE2', expiresAt: nextWeek() });
    everyone();
    fireEvent.click(within(await row('Jo')).getByRole('button', { name: 'Copy invite link' }));
    const ask = await screen.findByRole('dialog', { name: 'New invite link for Jo?' });
    expect(within(ask).getByText(/stops working/)).toBeTruthy();
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Make a new link' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith(3));
    expect(await screen.findByText('NEWC0DE2')).toBeTruthy();
    // Kept on this device, to copy again.
    expect(inviteFor(3)?.code).toBe('NEWC0DE2');
  });

  it('gives each account its actions in words, Remove last; an invite has no devices', async () => {
    everyone();
    fireEvent.click(await screen.findByRole('button', { name: 'More for Sam' }));
    expect(menuItems()).toEqual(['Edit', 'Devices', 'New setup code', 'Remove']);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Jo' }));
    expect(menuItems()).toEqual(['Edit', 'Remove']);
  });
});
