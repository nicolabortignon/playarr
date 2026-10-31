import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HealthStatus } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { RequestButton } from './Discover';

beforeEach(() => {
  // Requests are on, with Lidarr set up.
  vi.spyOn(api, 'health').mockResolvedValue({ ok: true, requests: true, lidarr: { ok: true } } as unknown as HealthStatus);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const album = { mbid: 'rg-1', artistName: 'Massive Attack', albumTitle: 'Mezzanine' };

function renderButton(availability: Parameters<typeof RequestButton>[0]['availability']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RequestButton album={album} availability={availability} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequestButton', () => {
  it('offers the rest of an album that is only partly in the library', async () => {
    const request = vi.spyOn(api, 'requestAlbum').mockResolvedValue({
      mbid: 'rg-1',
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      requestedAt: new Date().toISOString(),
      availability: { state: 'searching' },
    });
    renderButton({ state: 'partial', albumId: 5, have: 1, total: 12 });
    expect(screen.getByRole('button', { name: /1 of 12 songs in your library/ })).toBeTruthy();
    expect(screen.queryByText(/in library/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /request/i }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(album));
  });

  it('still says In library for a complete album', () => {
    renderButton({ state: 'available', albumId: 5 });
    expect(screen.getByRole('button', { name: /in library/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^request/i })).toBeNull();
  });
});
