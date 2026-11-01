import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { queryClient } from '../lib/queryClient';
import { ProfilesPanel } from './ProfilesPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
  usePrefs.setState({ profileId: null });
});

const view = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <ProfilesPanel />
    </QueryClientProvider>,
  );

describe('ProfilesPanel', () => {
  it('picks who listens on this device, sent with every request from then on', async () => {
    vi.spyOn(api, 'profiles').mockResolvedValue([
      { id: 1, name: 'Nicola' },
      { id: 2, name: 'Sam' },
    ]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
    view();
    expect((await screen.findByRole('radio', { name: /Nicola listens/ })).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Sam listens/ }));
    expect(usePrefs.getState().profileId).toBe(2);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Sam listens/ }).getAttribute('aria-checked')).toBe('true'));
    await api.recentAlbums();
    const headers = fetch.mock.calls.at(-1)![1]!.headers as Record<string, string>;
    expect(headers['X-Playarr-Profile']).toBe('2');
  });

  it('adds a profile', async () => {
    vi.spyOn(api, 'profiles').mockResolvedValue([{ id: 1, name: 'Home' }]);
    const create = vi.spyOn(api, 'createProfile').mockResolvedValue({ id: 2, name: 'Sam' });
    view();
    fireEvent.change(await screen.findByLabelText('New profile’s name'), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Sam'));
    expect(screen.queryByRole('button', { name: /Remove Home/ })).toBeNull(); // the only one can't go
  });
});
