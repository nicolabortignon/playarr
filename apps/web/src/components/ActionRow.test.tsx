import type { Track } from '@playarr/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ListPlus, RefreshCw } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from '../player/store';
import { ActionRow, RowAction, usePlayState, type ActionRowProps } from './ActionRow';

afterEach(() => {
  cleanup();
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false, source: undefined });
});

const track = { id: 1, fileId: 11, title: 'Airbag', recordingId: 'r1' } as Track;
const download = { item: { key: 'album:7', title: 'OK Computer', href: '/albums/7' }, tracks: [track] };
const menu = { label: 'More for “OK Computer”', items: [{ label: 'Play next', icon: ListPlus, onSelect: () => {} }] };

const row = (props: Partial<ActionRowProps> = {}) => (
  <ActionRow title="OK Computer" state="idle" onPlay={() => {}} onShuffle={() => {}} download={download} menu={menu} {...props} />
);

/** The row's controls in order, by what a screen reader calls them. */
const names = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);

describe('ActionRow', () => {
  it('holds Play, Shuffle, the page’s own action, Download and ⋯, in that order', () => {
    render(row({ action: <RowAction icon={<RefreshCw />}>New mix</RowAction> }));
    expect(names()).toEqual(['Play OK Computer', 'Shuffle OK Computer', 'New mix', 'Download OK Computer', 'More for “OK Computer”']);
  });

  it('plays and shuffles, and neither while there’s nothing to play', () => {
    const play = vi.fn();
    const shuffle = vi.fn();
    const { rerender } = render(row({ onPlay: play, onShuffle: shuffle }));
    fireEvent.click(screen.getByRole('button', { name: 'Play OK Computer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle OK Computer' }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(shuffle).toHaveBeenCalledTimes(1);
    rerender(row({ onPlay: play, onShuffle: shuffle, disabled: true }));
    expect((screen.getByRole('button', { name: 'Play OK Computer' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Shuffle OK Computer' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says Play, Pause and Resume, keeping every word so its width never changes', () => {
    const { rerender } = render(row({ state: 'idle' }));
    expect(screen.getByRole('button', { name: 'Play OK Computer' })).toBeTruthy();
    rerender(row({ state: 'playing' }));
    expect(screen.getByRole('button', { name: 'Pause OK Computer' })).toBeTruthy();
    rerender(row({ state: 'paused' }));
    const resume = screen.getByRole('button', { name: 'Resume OK Computer' });
    // The words not said stay in the button, hidden, holding its width.
    const hidden = [...resume.querySelectorAll('[aria-hidden="true"]')].map((w) => w.textContent).filter(Boolean);
    expect(hidden).toEqual(['Play', 'Pause']);
  });

  it('keeps the names of the buttons that drop their words as the row narrows', () => {
    render(row({ action: <RowAction icon={<RefreshCw />}>New mix</RowAction> }));
    const shuffle = screen.getByRole('button', { name: 'Shuffle OK Computer' });
    const action = screen.getByRole('button', { name: 'New mix' });
    // Words dropped are only visually hidden (still read out), and a tooltip says them.
    expect(shuffle.title).toBe('Shuffle');
    expect(action.title).toBe('New mix');
    expect(screen.getByText('Shuffle').className).toMatch(/row-step-1:sr-only/);
    expect(screen.getByText('New mix').className).toMatch(/row-step-2:sr-only/);
  });

  it('tells its container what it holds, which decides where it starts narrowing', () => {
    const layout = () => document.querySelector('[data-layout]')!.getAttribute('data-layout');
    const { rerender } = render(row({ action: <RowAction>Request the rest</RowAction> }));
    expect(layout()).toBe('action');
    rerender(row());
    expect(layout()).toBe('default');
    rerender(row({ download: undefined }));
    expect(layout()).toBe('short');
  });
});

describe('usePlayState', () => {
  function Probe({ href }: { href: string }) {
    return <p>{usePlayState(href)}</p>;
  }

  it('is the page’s only while the queue it started is still there', () => {
    render(<Probe href="/playlists/5" />);
    expect(screen.getByText('idle')).toBeTruthy();
    act(() => usePlayer.getState().playTracks([track], 0, { source: { label: 'Road trip', href: '/playlists/5' } }));
    expect(screen.getByText('playing')).toBeTruthy();
    act(() => usePlayer.getState().toggle());
    expect(screen.getByText('paused')).toBeTruthy();
    act(() => usePlayer.getState().playTracks([track], 0, { source: { label: 'Favorites', href: '/favorites' } }));
    expect(screen.getByText('idle')).toBeTruthy();
  });
});

describe('RowAction', () => {
  it('says what it’s doing while pending, in its words and its tooltip', () => {
    render(
      <RowAction pending pendingLabel="Mixing…">
        New mix
      </RowAction>,
    );
    const button = screen.getByRole('button', { name: 'Mixing…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Mixing…');
  });
});
