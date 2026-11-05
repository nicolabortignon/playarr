import type { PlaylistSummary } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { activeLink, Sidebar } from './Nav';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSidebar(path: string) {
  vi.spyOn(api, 'requests').mockResolvedValue([]);
  vi.spyOn(api, 'playlists').mockResolvedValue([{ id: 1, name: 'Late night', cover: { pending: false } } as PlaylistSummary]);
  const router = createMemoryRouter([{ path: '*', element: <Sidebar /> }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('sidebar', () => {
  it('knows which link a page belongs to', () => {
    expect(activeLink('/')?.label).toBe('Home');
    expect(activeLink('/albums/12')?.label).toBe('Albums');
    expect(activeLink('/artists')?.label).toBe('Artists');
    expect(activeLink('/playlists/3')).toBeUndefined();
    expect(activeLink('/settings')).toBeUndefined();
  });

  it('keeps Settings at the foot, without the library figures under it', async () => {
    renderSidebar('/albums');
    expect(await screen.findByRole('link', { name: 'Late night' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByText('Runtime')).toBeNull();
    expect(screen.queryByText('Streaming')).toBeNull();
  });

  it('folds the links to the one you are on once they scroll away, and opens them again at the top', async () => {
    renderSidebar('/albums');
    await screen.findByRole('link', { name: 'Late night' });
    const scroller = screen.getByRole('navigation', { name: 'Main' }).parentElement!;
    const folded = () => screen.getAllByRole('link', { name: 'Albums', hidden: true }).find((a) => a.closest('[aria-hidden]'))!.closest('[aria-hidden]')!;
    expect(folded().getAttribute('aria-hidden')).toBe('true');
    // jsdom lays nothing out: the links end at 0, so any scroll is past them.
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    expect(folded().getAttribute('aria-hidden')).toBe('false');
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(folded().getAttribute('aria-hidden')).toBe('true');
  });
});
