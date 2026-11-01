import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useClock } from '../player/store';
import { lineAt, LyricsView } from './LyricsView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const track = { id: 5, title: 'Yellow' } as Track;
const view = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LyricsView track={track} />
    </QueryClientProvider>,
  );

describe('LyricsView', () => {
  it('finds the line being sung', () => {
    const lines = [{ at: 5 }, { at: 10 }, { at: 20 }];
    expect(lineAt(lines, 1)).toBe(-1);
    expect(lineAt(lines, 10)).toBe(1);
    expect(lineAt(lines, 99)).toBe(2);
  });

  it('follows timed lyrics, and a line tapped plays from there', async () => {
    vi.spyOn(api, 'lyrics').mockResolvedValue({ synced: [{ at: 0, text: 'Look at the stars' }, { at: 12, text: 'Look how they shine' }], source: 'lrclib' });
    useClock.setState({ time: 13 });
    view();
    const second = await screen.findByRole('button', { name: 'Look how they shine' });
    expect(second.getAttribute('aria-current')).toBe('true');
    act(() => useClock.setState({ time: 1 }));
    expect(screen.getByRole('button', { name: 'Look at the stars' }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(second);
    expect(useClock.getState().seekRequest?.time).toBe(12);
    expect(screen.getByText('LRCLIB')).toBeTruthy();
  });

  it('says when there are none', async () => {
    vi.spyOn(api, 'lyrics').mockResolvedValue(null);
    view();
    expect(await screen.findByText('No lyrics found for this song.')).toBeTruthy();
  });
});
