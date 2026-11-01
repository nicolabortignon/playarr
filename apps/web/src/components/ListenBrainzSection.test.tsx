import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { ListenBrainzSection } from './ListenBrainzSection';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const view = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ListenBrainzSection />
    </QueryClientProvider>,
  );

describe('ListenBrainzSection', () => {
  it('connects with a token, then shows what was sent and offers the earlier plays', async () => {
    vi.spyOn(api, 'listenBrainz').mockResolvedValue({ connected: false, enabled: false, pending: 0, sent: 0, earlier: 0 });
    const save = vi
      .spyOn(api, 'saveListenBrainz')
      .mockResolvedValue({ connected: true, user: 'nicola', enabled: true, pending: 2, sent: 5, earlier: 40 });
    view();
    fireEvent.change(await screen.findByLabelText(/user token/i), { target: { value: ' abc ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Send plays to nicola')).toBeTruthy();
    expect(save).toHaveBeenCalledWith({ token: 'abc' });
    expect(screen.getByText(/5 listens sent · 2 waiting/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Also send 40 earlier plays' })).toBeTruthy();
  });
});
