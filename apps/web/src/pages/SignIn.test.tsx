import type { Account, ServerInfo } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remember, useAccounts } from '../lib/accounts';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { RedeemPage, SetupPage, SignInPage } from './SignIn';

const SERVER: ServerInfo = { id: 'u', name: 'NAS', version: '0.7.0', minAppVersion: '1.0.0', setup: false };
const NICOLA: Account = { id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useAccounts.setState({ accounts: [] });
  queryClient.clear();
});

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/redeem', element: <RedeemPage /> },
      { path: '/setup', element: <SetupPage /> },
      { path: '/albums', element: <p>Albums page</p> },
      { path: '/settings/accounts', element: <p>Accounts settings</p> },
      { path: '/', element: <p>Home page</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('sign-in pages', () => {
  it('signs in, keeps the account on this device and goes back where it was', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    const signIn = vi.spyOn(api, 'signIn').mockResolvedValue({ token: 'tok-1', account: NICOLA });
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(NICOLA);
    renderAt('/sign-in?next=%2Falbums');
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'nicola' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Albums page')).toBeTruthy();
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ username: 'nicola', password: 'correct horse', platform: 'web' }));
    expect(swap).toHaveBeenCalledWith('tok-1');
    expect(useAccounts.getState().accounts.map((a) => a.accountId)).toEqual([1]);
  });

  it('says what went wrong', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'signIn').mockRejectedValue(new ApiError('Wrong username or password', 401));
    renderAt('/sign-in');
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'nicola' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong username or password');
  });

  it('continues as an account already signed in on this device', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    remember({ token: 'tok-2', account: SAM });
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    renderAt('/sign-in');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue as Sam' }));
    expect(await screen.findByText('Home page')).toBeTruthy();
    expect(swap).toHaveBeenCalledWith('tok-2');
  });

  it('sends visitors of a server nobody has set up to set it up', async () => {
    vi.spyOn(api, 'server').mockResolvedValue({ ...SERVER, setup: true });
    renderAt('/sign-in');
    expect((await screen.findByRole('link', { name: 'Set up the owner’s account' })).getAttribute('href')).toBe('/setup');
  });

  it('chooses a first password with the code from a setup link', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    const redeem = vi.spyOn(api, 'redeem').mockResolvedValue({ token: 'tok-3', account: SAM });
    vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    renderAt('/redeem?code=ABCD2345');
    expect(((await screen.findByLabelText('Setup code')) as HTMLInputElement).value).toBe('ABCD2345');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'sams password' } });
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'sams passwrod' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The passwords don’t match');
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'sams password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose password' }));
    expect(await screen.findByText('Home page')).toBeTruthy();
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ code: 'ABCD2345', password: 'sams password', platform: 'web' }));
  });

  it('sets up the owner’s account, then opens Settings → Accounts', async () => {
    vi.spyOn(api, 'server').mockResolvedValue({ ...SERVER, setup: true });
    const setup = vi.spyOn(api, 'setup').mockResolvedValue({ token: 'tok-1', account: NICOLA });
    vi.spyOn(api, 'switchAccount').mockResolvedValue(NICOLA);
    renderAt('/setup');
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Nicola' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'nicola' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up Playarr' }));
    expect(await screen.findByText('Accounts settings')).toBeTruthy();
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ username: 'nicola', name: 'Nicola', password: 'correct horse' }));
  });

  it('pre-fills the owner’s username and says whose a taken one is, as the server puts it', async () => {
    vi.spyOn(api, 'server').mockResolvedValue({ ...SERVER, setup: true, ownerUsername: 'home' });
    vi.spyOn(api, 'setup').mockRejectedValue(new ApiError('That username belongs to Sam. Pick another; you can rename them later.', 409));
    renderAt('/setup');
    await waitFor(() => expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('home'));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Nicola' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'sam' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up Playarr' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That username belongs to Sam. Pick another; you can rename them later.');
  });

  it('asks to wait after too many tries, whatever answered', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'signIn').mockRejectedValue(new ApiError('Request failed (429)', 429));
    renderAt('/sign-in');
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'nicola' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Too many tries. Wait a few minutes and try again.');
  });
});
