import type { MissingTrack, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { HOLD_MS } from '../lib/contextMenu';
import { usePrefs } from '../lib/prefs';
import { useToasts } from '../lib/toast';
import { usePlayer } from '../player/store';
import { TrackList } from './TrackList';

const track = (id: number) =>
  ({
    id,
    recordingId: `rec-${id}`,
    fileId: id,
    albumId: 10,
    artistId: 20,
    title: `Song ${id}`,
    artistName: 'Massive Attack',
    albumTitle: 'Mezzanine',
    trackNumber: id,
    discNumber: 1,
    duration: 245,
    streamUrl: `/s/${id}`,
  }) as Track;

function list(props: Partial<Parameters<typeof TrackList>[0]> = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TrackList tracks={[track(1), track(2)]} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (title: string) => screen.getByRole('button', { name: `Play ${title}` }).closest('li')!;
const menuItems = () => within(screen.getByRole('menu')).queryAllByRole('menuitem').map((i) => i.textContent);

beforeEach(() => {
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
  usePrefs.setState({ transitions: 'off' });
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Song rows', () => {
  it('plays from a row whose main part is a real button, which the keyboard reaches and presses', () => {
    list();
    const play = screen.getByRole('button', { name: 'Play Song 2' });
    // A native button: Tab reaches it, and Enter or Space press it (the click a browser sends for them).
    expect(play.tagName).toBe('BUTTON');
    expect(play.getAttribute('tabindex')).toBeNull();
    play.focus();
    expect(document.activeElement).toBe(play);
    fireEvent.click(play, { detail: 0 });
    const s = usePlayer.getState();
    expect(s.queue[s.order[s.pos]!]!.title).toBe('Song 2');
    // The song playing pauses and resumes from its row instead of starting over.
    fireEvent.click(screen.getByRole('button', { name: 'Pause Song 2' }));
    expect(usePlayer.getState().playing).toBe(false);
  });

  it('keeps its controls apart from the row’s button, never inside it', () => {
    list({ variant: 'mixed' });
    const li = row('Song 1');
    const play = within(li).getByRole('button', { name: 'Play Song 1' });
    expect(play.querySelector('button, a')).toBeNull();
    // The links to the artist and the album are their own, and so are the heart and ⋯.
    expect(within(li).getByRole('link', { name: 'Massive Attack' }).getAttribute('href')).toBe('/artists/20');
    expect(within(li).getByRole('link', { name: 'Mezzanine' }).getAttribute('href')).toBe('/albums/10');
    expect(within(li).getByRole('button', { name: 'Add “Song 1” to favorites' })).toBeTruthy();
    expect(within(li).getByRole('button', { name: 'More for Song 1' })).toBeTruthy();
  });

  it('ends with the time, then the heart, then ⋯, as on iOS', () => {
    list();
    const li = row('Song 1');
    const time = within(li).getByText('4:05');
    const heart = within(li).getByRole('button', { name: 'Add “Song 1” to favorites' });
    const more = within(li).getByRole('button', { name: 'More for Song 1' });
    expect(time.compareDocumentPosition(heart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heart.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows one song menu, in one order', () => {
    list({ variant: 'mixed' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Song 1' }));
    expect(menuItems()).toEqual(['Play next', 'Add to queue', 'Add to playlist…', 'Start radio', 'Go to album', 'Go to artist', 'Show metadata']);
  });

  it('leaves Go to album out on the album’s own page, and adds Edit mix points at the end of the song’s part with DJ mix on', () => {
    usePrefs.setState({ transitions: 'dj' });
    list();
    fireEvent.click(screen.getByRole('button', { name: 'More for Song 1' }));
    expect(menuItems()).toEqual(['Play next', 'Add to queue', 'Add to playlist…', 'Start radio', 'Go to artist', 'Show metadata', 'Edit mix points']);
  });

  it('greys a missing song in its place, with nothing to press', () => {
    const missing: MissingTrack = { recordingId: 'rec-9', title: 'Exchange', trackNumber: 3, discNumber: 1, duration: 251 };
    list({ missing: [missing] });
    const li = screen.getByText('Exchange').closest('li')!;
    expect(li.title).toBe('Not in your library');
    expect(within(li).queryByRole('button')).toBeNull();
    expect(within(li).getByText('4:11')).toBeTruthy();
  });
});

describe('A row’s menu without its ⋯', () => {
  it('opens on a right-click, at the pointer', () => {
    list();
    const li = row('Song 2');
    fireEvent.pointerDown(li, { pointerType: 'mouse', button: 2 });
    const event = fireEvent.contextMenu(li, { clientX: 120, clientY: 80 });
    expect(event).toBe(false); // the browser's own menu is replaced
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('120px');
    expect(menu.style.top).toBe('80px');
    expect(menuItems()[0]).toBe('Play next');
    // From a pointer, the focus goes to the menu itself, not round its first item.
    expect(document.activeElement).toBe(menu);
  });

  it('leaves the browser’s own menu on a link, with a mouse', () => {
    list({ variant: 'mixed' });
    const link = within(row('Song 1')).getByRole('link', { name: 'Massive Attack' });
    fireEvent.pointerDown(link, { pointerType: 'mouse', button: 2 });
    expect(fireEvent.contextMenu(link)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the keyboard’s menu key by its ⋯, with the first item focused', () => {
    list();
    const play = screen.getByRole('button', { name: 'Play Song 1' });
    play.focus();
    fireEvent.contextMenu(play);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play next' }));
  });

  it('opens on a long press, and the press doesn’t also play the song', () => {
    vi.useFakeTimers();
    list();
    const play = screen.getByRole('button', { name: 'Play Song 1' });
    fireEvent.pointerDown(play, { pointerType: 'touch', button: 0, clientX: 40, clientY: 40 });
    act(() => vi.advanceTimersByTime(HOLD_MS - 1));
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(menuItems()[0]).toBe('Play next');
    // Below the finger, so it doesn't hide the first item.
    expect(parseFloat(screen.getByRole('menu').style.top)).toBeGreaterThan(40);
    fireEvent.pointerUp(play, { pointerType: 'touch' });
    fireEvent.click(play);
    expect(usePlayer.getState().pos).toBe(-1);
    // The tap that ends a long press, if it lands on an item, isn't a choice; a real tap is.
    const item = screen.getByRole('menuitem', { name: 'Add to queue' });
    fireEvent.click(item, { detail: 1 });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(item, { pointerType: 'touch' });
    fireEvent.click(item, { detail: 1 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(usePlayer.getState().queue.map((t) => t.title)).toEqual(['Song 1']);
  });

  it('gives way to scrolling: a finger that moves or that the browser takes over opens nothing', () => {
    vi.useFakeTimers();
    list();
    const li = row('Song 1');
    fireEvent.pointerDown(li, { pointerType: 'touch', button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerMove(li, { pointerType: 'touch', clientX: 40, clientY: 70 });
    act(() => vi.advanceTimersByTime(HOLD_MS * 2));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerDown(li, { pointerType: 'touch', button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerCancel(li, { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(HOLD_MS * 2));
    expect(screen.queryByRole('menu')).toBeNull();
    // A tap still plays.
    fireEvent.click(screen.getByRole('button', { name: 'Play Song 1' }));
    expect(usePlayer.getState().pos).toBe(0);
  });
});
