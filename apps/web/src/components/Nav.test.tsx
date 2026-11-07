import type { AlbumRequest, PlaylistSummary } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { activeLink, BottomNav, Sidebar } from './Nav';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSidebar(path: string, requests: AlbumRequest[] = [], element = <Sidebar />) {
  vi.spyOn(api, 'requests').mockResolvedValue(requests);
  vi.spyOn(api, 'playlists').mockResolvedValue([{ id: 1, name: 'Late night', cover: { pending: false } } as PlaylistSummary]);
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const request = (mbid: string, patch: Partial<AlbumRequest> = {}): AlbumRequest => ({
  mbid,
  title: mbid,
  artistName: 'Massive Attack',
  requestedAt: '2026-11-07T10:00:00Z',
  availability: { state: 'downloading', progress: 0.5 },
  ...patch,
});

/** An admin's requests: one of theirs that arrived since they last looked, Sam's waiting for them, two that are no news. */
const NEWS = [
  request('arrived', { availability: { state: 'available', albumId: 3 }, mine: true, unseen: true }),
  request('sams', { availability: { state: 'waiting' }, approval: 'waiting', mine: false, askedBy: ['Sam'] }),
  request('seen', { availability: { state: 'available', albumId: 4 }, mine: true, unseen: false }),
  request('on-its-way', { mine: false }),
];

describe('the badge on Requests', () => {
  it('counts what arrived since the last look and what waits for an admin’s answer, in the sidebar', async () => {
    renderSidebar('/albums', NEWS);
    const link = await screen.findByRole('link', { name: 'Requests 2 new' });
    expect(link.getAttribute('href')).toBe('/requests');
  });

  it('is on the phone’s Library tab, where Requests are', async () => {
    renderSidebar('/', NEWS, <BottomNav />);
    expect(await screen.findByRole('link', { name: 'Library 2 new' })).toBeTruthy();
  });

  it('shows nothing when nothing is news, though requests are on their way', async () => {
    renderSidebar('/albums', [request('on-its-way', { mine: true, unseen: false })]);
    expect(await screen.findByRole('link', { name: 'Requests' })).toBeTruthy();
  });
});

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
