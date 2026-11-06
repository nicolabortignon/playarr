import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useToasts } from '../lib/toast';
import { usePlayer } from '../player/store';
import { QueuePage } from './Queue';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 200, streamUrl: `/s/${id}` }) as Track;

const upcomingTitles = () => {
  const s = usePlayer.getState();
  return s.order.slice(s.pos + 1).map((i) => s.queue[i]!.title);
};

function renderQueue() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <QueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const openMenu = (title: string) => fireEvent.click(screen.getByRole('button', { name: `More for ${title}` }));
/** The menu's items, and its lines as "—". */
const menuEntries = () => [...screen.getByRole('menu').children].map((c) => (c.getAttribute('role') === 'separator' ? '—' : c.textContent));
const choose = (label: string) => fireEvent.click(screen.getByRole('menuitem', { name: label }));

beforeEach(() => {
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  usePlayer.setState({ queue: [1, 2, 3, 4].map(track), order: [0, 1, 2, 3], pos: 0, playing: false });
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Queue', () => {
  it('shows the song menu, then the queue’s own Move up, Move down and Remove after a line', () => {
    renderQueue();
    openMenu('Song 3');
    expect(menuEntries()).toEqual([
      'Play next',
      'Add to queue',
      'Add to playlist…',
      'Start radio',
      'Go to album',
      'Go to artist',
      'Show metadata',
      '—',
      'Move up',
      'Move down',
      'Remove from queue',
    ]);
  });

  it('leaves out what a song at either end can’t do', () => {
    renderQueue();
    openMenu('Song 2');
    expect(menuEntries()).not.toContain('Play next');
    expect(menuEntries()).not.toContain('Move up');
    fireEvent.keyDown(document, { key: 'Escape' });
    openMenu('Song 4');
    expect(menuEntries()).not.toContain('Move down');
  });

  it('moves a song up and down from its menu, as dragging does', () => {
    renderQueue();
    openMenu('Song 3');
    choose('Move up');
    expect(upcomingTitles()).toEqual(['Song 3', 'Song 2', 'Song 4']);
    openMenu('Song 3');
    choose('Move down');
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4']);
  });

  it('moves a song with the arrow keys on its handle', () => {
    renderQueue();
    const handle = screen.getByRole('button', { name: 'Drag to reorder Song 2' });
    expect(handle.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(upcomingTitles()).toEqual(['Song 3', 'Song 2', 'Song 4']);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to reorder Song 2' }), { key: 'ArrowUp' });
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4']);
  });

  it('moves a song to play next from its menu, saying so, with Undo', () => {
    renderQueue();
    openMenu('Song 4');
    choose('Play next');
    expect(upcomingTitles()).toEqual(['Song 4', 'Song 2', 'Song 3']);
    const [toast] = useToasts.getState().toasts;
    expect(toast!.message).toBe('“Song 4” plays next');
    act(() => toast!.action!.run());
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4']);
  });

  it('adds a song again at the end from Add to queue, and Undo takes that one back out', () => {
    renderQueue();
    openMenu('Song 2');
    choose('Add to queue');
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4', 'Song 2']);
    act(() => useToasts.getState().toasts[0]!.action!.run());
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4']);
  });

  it('shows each coming song’s length', () => {
    renderQueue();
    const row = screen.getByRole('button', { name: 'Play Song 3' }).closest('li')!;
    expect(within(row).getAllByText('3:20').length).toBeGreaterThan(0);
  });

  it('clears what comes up next, with Undo', () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(upcomingTitles()).toEqual([]);
    act(() => useToasts.getState().toasts[0]!.action!.run());
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4']);
  });
  it('removes a song at once, and Undo puts it back in its place', () => {
    renderQueue();
    openMenu('Song 3');
    choose('Remove from queue');
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 4']);
    const [toast] = useToasts.getState().toasts;
    expect(toast!.message).toBe('Removed “Song 3” from the queue');
    act(() => useToasts.getState().act(toast!.id));
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4']);
  });

  it('offers Feeling lucky when nothing is queued', () => {
    usePlayer.setState({ queue: [], order: [], pos: -1 });
    renderQueue();
    expect(screen.getByText('Nothing queued yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Feeling lucky' })).toBeTruthy();
  });
});
