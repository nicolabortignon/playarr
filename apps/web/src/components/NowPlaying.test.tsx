import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useUI } from '../lib/ui';
import { usePlayer } from '../player/store';
import { NowPlaying } from './NowPlaying';
import { MiniPlayer } from './PlayerBar';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 200, streamUrl: `/s/${id}` }) as Track;

function wrap(children: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The open menu's items, and its lines as "—". */
const menuEntries = () => [...screen.getByRole('menu').children].map((c) => (c.getAttribute('role') === 'separator' ? '—' : c.textContent));

beforeEach(() => {
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  vi.spyOn(api, 'lyrics').mockResolvedValue(null);
  usePrefs.setState({ transitions: 'off' });
  usePlayer.setState({ queue: [1, 2, 3].map(track), order: [0, 1, 2], pos: 0, playing: true });
  useUI.setState({ nowPlayingOpen: true, lyricsOpen: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Now Playing', () => {
  it('gives the song playing the one song menu, without queueing it again, and Open queue after a line', () => {
    wrap(<NowPlaying />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(menuEntries()).toEqual(['Add to playlist…', 'Start radio', 'Go to album', 'Go to artist', 'Show metadata', '—', 'Open queue']);
  });

  it('gives Up next’s songs the queue’s menu, and a press plays from there', () => {
    wrap(<NowPlaying />);
    fireEvent.click(screen.getByRole('button', { name: 'More for Song 3' }));
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
      'Remove from queue',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    const s = usePlayer.getState();
    expect(s.order.slice(s.pos + 1).map((i) => s.queue[i]!.title)).toEqual(['Song 3', 'Song 2']);
    fireEvent.click(screen.getByRole('button', { name: 'Play Song 2' }));
    expect(usePlayer.getState().pos).toBe(2);
  });
});

describe('Mini player', () => {
  it('is an Open now playing button beside its own controls, not buttons inside a button', () => {
    wrap(<MiniPlayer />);
    const open = screen.getByRole('button', { name: 'Open now playing' });
    expect(open.tagName).toBe('BUTTON');
    expect(open.querySelector('button')).toBeNull();
    expect(open.textContent).toContain('Song 1');
    for (const name of ['Add “Song 1” to favorites', 'Pause', 'Next']) {
      const control = screen.getByRole('button', { name });
      expect(open.contains(control)).toBe(false);
    }
    fireEvent.click(open);
    expect(useUI.getState().nowPlayingOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(usePlayer.getState().pos).toBe(1);
  });
});
