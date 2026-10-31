import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { SimilarArtists } from './SimilarArtists';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SimilarArtists', () => {
  it('shows similar artists in the library apart from the others, each opening the right page', async () => {
    vi.spyOn(api, 'similarArtists').mockResolvedValue([
      { mbid: 'a', name: 'Backstreet Boys', genres: [], artistId: 12 },
      { mbid: 'b', name: '98 Degrees', genres: [] },
    ]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SimilarArtists mbid="nsync" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Similar artists in your library')).toBeTruthy();
    expect(screen.getByText('More similar artists')).toBeTruthy();
    expect(screen.getByText('Backstreet Boys').closest('a')!.getAttribute('href')).toBe('/artists/12');
    expect(screen.getByText('98 Degrees').closest('a')!.getAttribute('href')).toBe('/discover/artists/b');
  });
});
