import type { Album, LuckyMix, Track } from '@playarr/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { queryClient } from '../lib/queryClient';
import { usePlayer } from '../player/store';
import { coversAtHand, flickCovers, LuckyButton } from './LuckyButton';

const song = (id: number, albumId: number) =>
  ({ id, fileId: id, recordingId: `r${id}`, albumId, title: `Song ${id}`, coverUrl: `/art/album/${albumId}/cover`, coverColor: '#203040', streamUrl: `/s/${id}` }) as Track;
/** Feeling lucky's songs: the first from album 1, then albums 2, 2, 3, 4, 5. */
const FOUND = [song(1, 1), song(2, 2), song(3, 2), song(4, 3), song(5, 4), song(6, 5)];
/** Albums on Home's shelves, loaded before the press. */
const SHELF = [20, 21, 22, 23].map((id) => ({ id, title: `Album ${id}`, coverUrl: `/art/album/${id}/cover`, coverColor: '#405060' }) as Album);

/** Feeling lucky's answer, held back until `answer()`: while it picks. */
function picking() {
  let answer!: () => void;
  vi.spyOn(api, 'lucky').mockReturnValue(new Promise<LuckyMix>((resolve) => (answer = () => resolve({ tracks: FOUND, subtitle: 'Evening: warm' }))));
  return () => act(() => answer());
}
const flick = () => document.querySelector<HTMLElement>('[data-flick]');

beforeEach(() => {
  usePrefs.setState({ motion: 'full' });
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('the covers Feeling lucky flicks past', () => {
  it('are, while it picks, the albums already loaded, each once', () => {
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    queryClient.setQueryData(['recent-albums'], [SHELF[0], { ...SHELF[1]!, id: 30, coverUrl: '/art/album/30/cover' }]);
    expect(coversAtHand().map((c) => c.key).sort()).toEqual([20, 21, 22, 23, 30].map((id) => `/art/album/${id}/cover`).sort());
    queryClient.clear();
    expect(coversAtHand()).toEqual([]);
  });

  it('are, with nothing loaded, three of the other songs’ albums, each once, then the first song’s, where it lands', () => {
    expect(flickCovers(FOUND).map((c) => c.key)).toEqual(['/art/album/2/cover', '/art/album/3/cover', '/art/album/4/cover', '/art/album/1/cover']);
    expect(flickCovers([song(1, 1), song(2, 1), song(3, 2)]).map((c) => c.key)).toEqual(['/art/album/2/cover', '/art/album/1/cover']);
    expect(flickCovers([])).toEqual([]);
  });
});

describe('Feeling lucky', () => {
  it('flicks through covers while it picks, and lands on the first song’s as the music starts', async () => {
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    const answer = picking();
    render(<LuckyButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feeling lucky' }));
    expect(flick()?.dataset.flick).toBe('flicking');
    expect(SHELF.map((a) => a.coverUrl)).toContain(flick()!.querySelector<HTMLElement>('[data-cover]')!.dataset.cover);
    // Its words stay its name while the covers flick where they were.
    expect(screen.getByRole('button', { name: 'Feeling lucky' })).toBeTruthy();
    await answer();
    expect(usePlayer.getState().queue.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6]);
    await waitFor(() => expect(document.querySelector('[data-flick="landed"] [data-cover="/art/album/1/cover"]')).not.toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(flick()).toBeNull(), { timeout: 3000 });
  });

  it('flicks through songs it found when nothing is loaded to flick through while it picks', async () => {
    const answer = picking();
    render(<LuckyButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feeling lucky' }));
    expect(flick()).toBeNull();
    await answer();
    expect(flick()).not.toBeNull();
    await waitFor(() => expect(document.querySelector('[data-flick="landed"] [data-cover="/art/album/1/cover"]')).not.toBeNull(), { timeout: 3000 });
  });

  it('keeps still under Reduce Motion: the sparkles say it’s picking, and the music starting says what it found', async () => {
    usePrefs.setState({ motion: 'reduce' });
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    const answer = picking();
    render(<LuckyButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Feeling lucky' }));
    expect(flick()).toBeNull();
    await answer();
    await waitFor(() => expect(usePlayer.getState().queue).toHaveLength(6));
    expect(flick()).toBeNull();
  });
});
