import type { Account, LastFmInfo } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { LastFmSection } from './LastFmSection';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const info = (patch: Partial<LastFmInfo> = {}): LastFmInfo => ({ available: true, connected: false, enabled: false, pending: 0, sent: 0, earlier: 0, ...patch });

function view(role: Account['role'] = 'admin') {
  vi.spyOn(api, 'me').mockResolvedValue({ id: 1, username: 'alex', name: 'Alex', role, canRequest: false, sources: null, hasPassword: true } as Account);
  const router = createMemoryRouter([{ path: '/', element: <LastFmSection /> }]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('LastFmSection', () => {
  it('has an admin add the server’s API account first, and tells anyone else an admin can', async () => {
    vi.spyOn(api, 'lastFm').mockResolvedValue(info({ available: false }));
    const save = vi.spyOn(api, 'saveLastFmApp').mockResolvedValue(info({ apiKey: 'a'.repeat(26) + 'abc123' }));
    view();
    fireEvent.change(await screen.findByLabelText('API key'), { target: { value: ' key ' } });
    fireEvent.change(screen.getByLabelText('Shared secret'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Last.fm' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ apiKey: 'key', secret: 'secret' }));
    expect(await screen.findByRole('button', { name: 'Connect Last.fm' })).toBeTruthy();
    expect(screen.getByText('…abc123')).toBeTruthy();
    cleanup();

    view('member');
    expect(await screen.findByText('An admin can add Last.fm to this server.')).toBeTruthy();
  });

  it('connects by allowing Playarr on Last.fm, then finishing, and shows what was sent', async () => {
    vi.spyOn(api, 'lastFm').mockResolvedValue(info());
    vi.spyOn(api, 'connectLastFm').mockResolvedValue({ url: 'https://www.last.fm/api/auth/?api_key=k&token=t', token: 't' });
    const finish = vi.spyOn(api, 'finishLastFm').mockResolvedValue(info({ connected: true, user: 'nicola', enabled: true, sent: 3, pending: 1, earlier: 12 }));
    view('member');
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Last.fm' }));
    const allow = await screen.findByRole('link', { name: 'Allow Playarr on Last.fm' });
    expect(allow.getAttribute('href')).toBe('https://www.last.fm/api/auth/?api_key=k&token=t');
    expect(allow.getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));
    expect(await screen.findByText('Send plays to nicola')).toBeTruthy();
    expect(finish).toHaveBeenCalledWith('t');
    expect(screen.getByText(/3 scrobbles sent · 1 waiting/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Also send 12 earlier plays' })).toBeTruthy();
  });
});
