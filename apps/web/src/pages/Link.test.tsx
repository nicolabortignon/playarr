import type { Account } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { LinkPage } from './Link';

const ALEX: Account = { id: 1, username: 'alex', name: 'Alex', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const TV = { device: 'Living room TV', platform: 'tv', expiresAt: '2026-11-15T12:10:00Z' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function view(path: string) {
  vi.spyOn(api, 'me').mockResolvedValue(ALEX);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <LinkPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Sign in a TV', () => {
  it('shows which TV the code is for and signs it in as the account listening here', async () => {
    const lookup = vi.spyOn(api, 'deviceLookup').mockResolvedValue(TV);
    const approve = vi.spyOn(api, 'deviceApprove').mockResolvedValue(TV);
    view('/link?code=abcd-2345');
    expect(lookup).toHaveBeenCalledWith('ABCD2345');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in Living room TV as Alex' }));
    expect(await screen.findByText('Living room TV is signed in')).toBeTruthy();
    expect(approve).toHaveBeenCalledWith('ABCD2345');
  });

  it('asks for the code when the link has none', async () => {
    const lookup = vi.spyOn(api, 'deviceLookup').mockResolvedValue(TV);
    view('/link');
    const button = screen.getByRole('button', { name: 'Continue' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'abcd 2345' } });
    fireEvent.click(button);
    expect(await screen.findByRole('button', { name: 'Sign in Living room TV as Alex' })).toBeTruthy();
    expect(lookup).toHaveBeenCalledWith('ABCD2345');
  });

  it('says when a code is wrong, used or expired', async () => {
    vi.spyOn(api, 'deviceLookup').mockRejectedValue(new ApiError('That code is wrong, used or expired. Start again on the TV.', 404));
    view('/link?code=WRONG234');
    expect(await screen.findByText('That code is wrong, used or expired. Start again on the TV.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
  });
});
