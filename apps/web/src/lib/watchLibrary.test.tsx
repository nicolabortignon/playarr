import type { HealthStatus } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { useWatchLibrary } from './queries';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const health = (albums: number, tracks: number, refreshedAt = '2026-11-07T10:00:00Z'): HealthStatus => ({
  ok: true,
  media: { source: 'local', ok: true },
  library: { artists: 10, albums, tracks, durationSeconds: 3600, sizeBytes: tracks * 1000, refreshedAt },
  requests: true,
});

describe('useWatchLibrary', () => {
  it('asks for the library’s pages again once health says it changed, not at the first look or after a sync that found nothing', async () => {
    const asked = vi.spyOn(api, 'health').mockResolvedValue(health(100, 1200));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidated = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useWatchLibrary(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await waitFor(() => expect(client.getQueryData(['health'])).toBeDefined());
    expect(invalidated).not.toHaveBeenCalled();
    // Synced again, nothing new.
    asked.mockResolvedValue(health(100, 1200, '2026-11-07T10:15:00Z'));
    await act(() => client.refetchQueries({ queryKey: ['health'] }));
    expect(invalidated).not.toHaveBeenCalled();
    // An album someone else asked for arrived.
    asked.mockResolvedValue(health(101, 1212, '2026-11-07T10:30:00Z'));
    await act(() => client.refetchQueries({ queryKey: ['health'] }));
    await waitFor(() => expect(invalidated).toHaveBeenCalledWith({ queryKey: ['albums'] }));
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['search'] });
    expect(invalidated).not.toHaveBeenCalledWith({ queryKey: ['health'] });
  });
});
