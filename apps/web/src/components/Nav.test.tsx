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

  it('folds the links to the one you are on as the playlists scroll, and opens them again at the top', async () => {
    renderSidebar('/albums');
    await screen.findByRole('link', { name: 'Late night' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const column = nav.parentElement!;
    // jsdom lays nothing out: a column with far more playlists than room.
    Object.defineProperty(column, 'scrollHeight', { value: 2000 });
    Object.defineProperty(column, 'clientHeight', { value: 600 });
    const shut = (label: string) => !!screen.getByRole('link', { name: label, hidden: true }).closest('[inert]');
    expect(shut('Home')).toBe(false);
    column.scrollTop = 30;
    fireEvent.scroll(column);
    expect(nav.dataset.folded).toBe('true');
    expect(shut('Home')).toBe(true);
    expect(shut('Queue')).toBe(true);
    expect(shut('Albums')).toBe(false);
    column.scrollTop = 0;
    fireEvent.scroll(column);
    expect(nav.dataset.folded).toBe('false');
    expect(shut('Home')).toBe(false);
  });

  it('folds a list that only just overflows, keeping room under it to scroll back up', async () => {
    renderSidebar('/albums');
    await screen.findByRole('link', { name: 'Late night' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const column = nav.parentElement!;
    Object.defineProperty(column, 'scrollHeight', { value: 700 });
    Object.defineProperty(column, 'clientHeight', { value: 600 });
    Object.defineProperty(nav, 'offsetHeight', { value: 360 });
    column.scrollTop = 30;
    fireEvent.scroll(column);
    expect(nav.dataset.folded).toBe('true');
    // 360 of links out, 100 of overflow, 30 scrolled: 290 under the playlists keeps the column where it was.
    expect((column.lastElementChild as HTMLElement).style.height).toBe('290px');
    column.scrollTop = 0;
    fireEvent.scroll(column);
    expect(nav.dataset.folded).toBe('false');
    expect((column.lastElementChild as HTMLElement).style.height).toBe('');
  });
});
