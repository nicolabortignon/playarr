import type { Account } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remember, useAccounts } from '../lib/accounts';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { AccountSwitcher } from './AccountSwitcher';

const NICOLA: Account = { id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useAccounts.setState({ accounts: [] });
  queryClient.clear();
});

const view = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccountSwitcher />
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe('AccountSwitcher', () => {
  it('switches between the accounts signed in on this device, or adds one', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(NICOLA);
    remember({ token: 'tok-1', account: NICOLA });
    remember({ token: 'tok-2', account: SAM });
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    view();
    expect(await screen.findByText('Not Nicola?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add account' }).getAttribute('href')).toBe('/sign-in?add=1');
    expect(screen.queryByRole('button', { name: 'Listen as Nicola' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Listen as Sam' }));
    await waitFor(() => expect(swap).toHaveBeenCalledWith('tok-2'));
  });

  it('stays out of sight while nobody is signed in (setup mode)', async () => {
    const me = vi.spyOn(api, 'me').mockRejectedValue(new ApiError('Nobody is signed in', 401));
    const { container } = view();
    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
