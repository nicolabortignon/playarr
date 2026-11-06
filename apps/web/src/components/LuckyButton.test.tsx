import type { Album, LuckyMix, Track } from '@playarr/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { queryClient } from '../lib/queryClient';
import { usePlayer } from '../player/store';
import { coversAtHand, fanCovers, LuckyButton } from './LuckyButton';

const song = (id: number, albumId: number) =>
  ({ id, fileId: id, recordingId: `r${id}`, albumId, title: `Song ${id}`, coverUrl: `/art/album/${albumId}/cover`, coverColor: '#203040', streamUrl: `/s/${id}` }) as Track;
/** Feeling lucky's songs: the first from album 1, then albums 2, 2, 3, 4, 5. */
const FOUND = [song(1, 1), song(2, 2), song(3, 2), song(4, 3), song(5, 4), song(6, 5)];
/** Albums on Home's shelves, loaded before the press. */
const SHELF = [20, 21, 22, 23].map((id) => ({ id, title: `Album ${id}`, coverUrl: `/art/album/${id}/cover`, coverColor: '#405060' }) as Album);

/** Feeling lucky's answer (its songs, unless said), held back until `answer()`: while it picks. */
function picking(mix: LuckyMix = { tracks: FOUND, subtitle: 'Evening: warm' }) {
  let answer!: () => void;
  vi.spyOn(api, 'lucky').mockReturnValue(new Promise<LuckyMix>((resolve) => (answer = () => resolve(mix))));
  return () => act(() => answer());
}
const fan = () => document.querySelector<HTMLElement>('[data-fan]');
/** The covers in the fan, in the order dealt. */
const dealt = () => [...document.querySelectorAll<HTMLElement>('[data-fan] [data-cover]')].map((c) => c.dataset.cover);
const button = () => screen.getByRole('button', { name: 'Feeling lucky' });
const press = () => fireEvent.click(button());

/** Pictures load at once (happy-dom loads none). */
class LoadingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  complete = false;
  set src(_: string) {
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  vi.stubGlobal('Image', LoadingImage);
  usePrefs.setState({ motion: 'full' });
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe('the covers Feeling lucky deals', () => {
  it('are, while it picks, the albums already loaded, each once', () => {
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    queryClient.setQueryData(['recent-albums'], [SHELF[0], { ...SHELF[1]!, id: 30, coverUrl: '/art/album/30/cover' }]);
    expect(coversAtHand().map((c) => c.key).sort()).toEqual([20, 21, 22, 23, 30].map((id) => `/art/album/${id}/cover`).sort());
    queryClient.clear();
    expect(coversAtHand()).toEqual([]);
  });

  it('are, with nothing loaded, three of the other songs’ albums, each once, then the first song’s', () => {
    expect(fanCovers(FOUND).map((c) => c.key)).toEqual(['/art/album/2/cover', '/art/album/3/cover', '/art/album/4/cover', '/art/album/1/cover']);
    expect(fanCovers([song(1, 1), song(2, 1), song(3, 2)]).map((c) => c.key)).toEqual(['/art/album/2/cover', '/art/album/1/cover']);
    expect(fanCovers([])).toEqual([]);
  });
});

describe('Feeling lucky', () => {
  it('asks for the songs as the pointer comes over it, so the first song’s cover goes out in one rhythm with the others', async () => {
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    const lucky = vi.spyOn(api, 'lucky').mockResolvedValue({ tracks: FOUND, subtitle: 'Evening: warm' });
    render(<LuckyButton />);
    fireEvent.pointerEnter(button());
    fireEvent.pointerEnter(button());
    expect(lucky).toHaveBeenCalledTimes(1);
    await act(async () => {});
    press();
    await waitFor(() => expect(fan()).not.toBeNull());
    // All five from the start: the covers at hand, then the first song's, last and on top.
    expect(dealt()).toHaveLength(5);
    expect(dealt().slice(0, 4).sort()).toEqual(SHELF.map((a) => a.coverUrl).sort());
    expect(dealt().at(-1)).toBe('/art/album/1/cover');
    expect(usePlayer.getState().queue.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lucky).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fan()?.dataset.fan).toBe('back'), { timeout: 3000 });
    await waitFor(() => expect(fan()).toBeNull(), { timeout: 3000 });
  });

  it('asks afresh at the next press', async () => {
    const lucky = vi.spyOn(api, 'lucky').mockResolvedValue({ tracks: FOUND, subtitle: 'Evening: warm' });
    render(<LuckyButton />);
    fireEvent.pointerEnter(button());
    press();
    await waitFor(() => expect(usePlayer.getState().queue).toHaveLength(6));
    await waitFor(() => expect(button().hasAttribute('disabled')).toBe(false));
    press();
    await waitFor(() => expect(lucky).toHaveBeenCalledTimes(2));
  });

  it('while the songs take a while, deals the covers at hand after a moment, then the first song’s once it’s known', async () => {
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    const answer = picking();
    render(<LuckyButton />);
    press();
    expect(fan()).toBeNull();
    await waitFor(() => expect(fan()?.dataset.fan).toBe('open'));
    expect(dealt().sort()).toEqual(SHELF.map((a) => a.coverUrl).sort());
    // The fan is behind the button, which keeps its name.
    expect(button()).toBeTruthy();
    await answer();
    expect(usePlayer.getState().queue.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6]);
    await waitFor(() => expect(dealt()).toHaveLength(5));
    expect(dealt().at(-1)).toBe('/art/album/1/cover');
  });

  it('swaps a card showing the first song’s album for another at hand, so no album is dealt twice', async () => {
    // With Math.random at 0 the shuffle moves the first cover at hand to the end: album 1 is dealt, 20 is spare.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    queryClient.setQueryData(['albums', 'added', 14], [20, 1, 21, 22, 23].map((id) => ({ ...SHELF[0]!, id, coverUrl: `/art/album/${id}/cover` })));
    const answer = picking();
    render(<LuckyButton />);
    press();
    await waitFor(() => expect(dealt()).toEqual([1, 21, 22, 23].map((id) => `/art/album/${id}/cover`)));
    await answer();
    await waitFor(() => expect(dealt()).toEqual([20, 21, 22, 23, 1].map((id) => `/art/album/${id}/cover`)));
  });

  it('deals songs it found when nothing is loaded to deal while it picks', async () => {
    const answer = picking();
    render(<LuckyButton />);
    press();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(fan()).toBeNull();
    await answer();
    await waitFor(() => expect(dealt()).toEqual(['/art/album/2/cover', '/art/album/3/cover', '/art/album/4/cover', '/art/album/1/cover']));
    await waitFor(() => expect(fan()).toBeNull(), { timeout: 3000 });
  });

  it('puts the cards out back when it finds nothing, and deals none when it says so at once', async () => {
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    const answer = picking({ tracks: [], subtitle: '' });
    render(<LuckyButton />);
    press();
    await waitFor(() => expect(dealt()).toHaveLength(4));
    await answer();
    await waitFor(() => expect(fan()?.dataset.fan).toBe('back'), { timeout: 3000 });
    await waitFor(() => expect(fan()).toBeNull(), { timeout: 3000 });

    vi.spyOn(api, 'lucky').mockResolvedValue({ tracks: [], subtitle: '' });
    press();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(fan()).toBeNull();
  });

  it('keeps still under Reduce Motion: the sparkles say it’s picking, and the music starting says what it found', async () => {
    usePrefs.setState({ motion: 'reduce' });
    queryClient.setQueryData(['albums', 'added', 14], SHELF);
    const answer = picking();
    render(<LuckyButton />);
    press();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(fan()).toBeNull();
    await answer();
    await waitFor(() => expect(usePlayer.getState().queue).toHaveLength(6));
    expect(fan()).toBeNull();
  });
});
