import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { FavoritesPage } from './Favorites';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Favorites', () => {
  it('says where hearted songs go before there are any, and where to find some', async () => {
    vi.spyOn(api, 'favorites').mockResolvedValue([]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <FavoritesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Songs you heart land here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find something to love' }).getAttribute('href')).toBe('/');
    // Nothing to play yet: no Play button promising songs.
    expect(screen.queryByRole('button', { name: 'Play Favorites' })).toBeNull();
  });
});
