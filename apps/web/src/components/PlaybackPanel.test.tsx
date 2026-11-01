import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MixMapProgress } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { PlaybackPanel } from './PlaybackPanel';

const PROGRESS: MixMapProgress = { enabled: true, songs: 5678, ready: 1234, failed: 3, waiting: 4400, working: 1, libraryScan: true };

/** The panel against a fake server answering each progress request with the next of `answers` (the last one repeats). */
function view(...answers: Partial<MixMapProgress>[]) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      const answer = { ...PROGRESS, ...(answers[Math.min(asked.length, answers.length) - 1] ?? {}) };
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PlaybackPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { asked };
}

const transitions = () => within(screen.getByRole('radiogroup', { name: 'Transitions' }));
const lengths = () => screen.queryByRole('radiogroup', { name: 'Crossfade length' });

beforeEach(() => usePrefs.setState({ transitions: 'off', crossfade: 0 }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PlaybackPanel transitions', () => {
  it('offers crossfade lengths only once Crossfade is chosen', () => {
    view();
    expect(transitions().getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
    expect(lengths()).toBeNull();
    fireEvent.click(transitions().getByRole('radio', { name: 'Crossfade' }));
    expect(usePrefs.getState()).toMatchObject({ transitions: 'crossfade', crossfade: 6 });
    expect(lengths()).not.toBeNull();
    expect(screen.getByRole('radio', { name: '6 s' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(transitions().getByRole('radio', { name: 'DJ mix' }));
    expect(usePrefs.getState().transitions).toBe('dj');
    expect(lengths()).toBeNull();
    expect(screen.getByText(/mixed like a DJ would/)).toBeTruthy();
  });
});

describe('PlaybackPanel DJ mix progress', () => {
  it('says nothing about it, and asks nothing, unless DJ mix is chosen', async () => {
    const { asked } = view();
    fireEvent.click(transitions().getByRole('radio', { name: 'Crossfade' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/ready for DJ mix/)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('counts the songs ready, waiting and failed while the library is analysed', async () => {
    usePrefs.setState({ transitions: 'dj' });
    view();
    expect(await screen.findByText('Ready for DJ mix: 1,234 of 5,678 songs · 4,400 waiting to be analysed · 3 couldn’t be analysed.')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Songs ready for DJ mix' }).getAttribute('aria-valuenow')).toBe('1234');
  });

  it('says when every song is ready', async () => {
    usePrefs.setState({ transitions: 'dj' });
    view({ ready: 5678, failed: 0, waiting: 0, working: 0 });
    expect(await screen.findByText('All 5,678 songs are ready for DJ mix.')).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('says songs are analysed as they come up when the library isn’t measured as a whole', async () => {
    usePrefs.setState({ transitions: 'dj' });
    view({ libraryScan: false, failed: 0 });
    expect(await screen.findByText(/^1,234 of 5,678 songs are ready for DJ mix\. Others are analysed as they come up to play/)).toBeTruthy();
    expect(screen.queryByText(/waiting/)).toBeNull();
  });

  it('says when audio analysis is off', async () => {
    usePrefs.setState({ transitions: 'dj' });
    view({ enabled: false });
    expect(await screen.findByText(/DJ mix needs audio analysis, which is off on this server/)).toBeTruthy();
  });

  it('asks again while songs are being analysed, and stops once none are left', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    usePrefs.setState({ transitions: 'dj' });
    const { asked } = view({}, { ready: 5678, failed: 0, waiting: 0, working: 0 });
    await screen.findByText(/4,400 waiting/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await screen.findByText('All 5,678 songs are ready for DJ mix.')).toBeTruthy();
    expect(asked).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(2);
  });
});
