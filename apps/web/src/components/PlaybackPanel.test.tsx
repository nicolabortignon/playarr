import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MixMapProgress } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useToasts } from '../lib/toast';
import { PlaybackPanel } from './PlaybackPanel';

const PROGRESS: MixMapProgress = { enabled: true, songs: 5678, ready: 1234, beatModel: 1234, failed: 3, waiting: 4400, working: 1, libraryScan: true };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The panel against a fake server answering each progress request with the next of `answers` (the
 * last one repeats), and Analyse all songs now with `analyzed`.
 */
function view(...answers: Partial<MixMapProgress>[]) {
  const asked: string[] = [];
  const analyzed: { answer: () => Response | Promise<Response>; bodies: unknown[] } = { answer: () => json({ queued: 4400 }), bodies: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/mix-maps/analyze' && init?.method === 'POST') {
        analyzed.bodies.push(JSON.parse(String(init.body)));
        return analyzed.answer();
      }
      asked.push(url);
      return json({ ...PROGRESS, ...(answers[Math.min(asked.length, answers.length) - 1] ?? {}) });
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
  return { asked, analyzed };
}

const transitions = () => within(screen.getByRole('radiogroup', { name: 'Transitions' }));
const lengths = () => screen.queryByRole('radiogroup', { name: 'Crossfade length' });

beforeEach(() => usePrefs.setState({ transitions: 'off', crossfade: 0 }));
afterEach(() => {
  cleanup();
  useToasts.setState({ toasts: [] });
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

  it('offers DJ mix a fade length, for songs it can’t mix on the beat', () => {
    usePrefs.setState({ transitions: 'dj', crossfade: 6 });
    view();
    const fades = within(screen.getByRole('radiogroup', { name: 'Fade length' }));
    expect(fades.getByRole('radio', { name: '6 s' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(fades.getByRole('radio', { name: '12 s' }));
    expect(usePrefs.getState().crossfade).toBe(12);
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
    view({ ready: 5678, beatModel: 5678, failed: 0, waiting: 0, working: 0 });
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
    const { asked } = view({}, { ready: 5678, beatModel: 5678, failed: 0, waiting: 0, working: 0 });
    await screen.findByText(/4,400 waiting/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await screen.findByText('All 5,678 songs are ready for DJ mix.')).toBeTruthy();
    expect(asked).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(2);
  });

  it('offers to analyse the songs not ready yet, but not while they’re being analysed, all ready, or without analysis', async () => {
    usePrefs.setState({ transitions: 'dj' });
    const button = () => screen.queryByRole('button', { name: 'Analyse all songs now' });
    for (const [answer, shown] of [
      [{ libraryScan: false, waiting: 0, working: 0 }, true],
      [{ waiting: 0, working: 1 }, false],
      [{ waiting: 3, working: 0 }, false],
      [{ ready: 5678, beatModel: 5678, failed: 0, waiting: 0, working: 0 }, false],
      // The rest failed lately: they're tried again tomorrow, there's nothing to start now.
      [{ ready: 5675, failed: 3, waiting: 0, working: 0 }, false],
      [{ enabled: false, waiting: 0, working: 0 }, false],
    ] as const) {
      view(answer);
      await screen.findByText(/DJ mix/, { selector: 'p.text-paper-dim' });
      expect(!!button(), JSON.stringify(answer)).toBe(shown);
      cleanup();
    }
  });

  it('starts the analysis, says how many songs, and follows it from then on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    usePrefs.setState({ transitions: 'dj' });
    const { asked, analyzed } = view({ waiting: 0, working: 0 }, { waiting: 4400, working: 1 }, { ready: 5678, beatModel: 5678, failed: 0, waiting: 0, working: 0 });
    let answer!: (response: Response) => void;
    analyzed.answer = () => new Promise((resolve) => (answer = resolve));
    const button = await screen.findByRole('button', { name: 'Analyse all songs now' });
    fireEvent.click(button);
    // One press at a time.
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    answer(json({ queued: 4400 }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Analysing 4,400 songs in the background']));
    // The progress is asked again at once, and then while songs are waiting.
    expect(await screen.findByText(/4,400 waiting/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Analyse all songs now' })).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await screen.findByText('All 5,678 songs are ready for DJ mix.')).toBeTruthy();
    expect(asked).toHaveLength(3);
  });

  it('offers to analyse every song again whenever nothing is under way, and asks the server for all of them', async () => {
    usePrefs.setState({ transitions: 'dj' });
    const button = () => screen.queryByRole('button', { name: 'Analyse all again' });
    for (const [answer, shown] of [
      [{ ready: 5678, beatModel: 5678, failed: 0, waiting: 0, working: 0 }, true],
      [{ waiting: 0, working: 0 }, true],
      [{ waiting: 0, working: 1 }, false],
      [{ ready: 0, beatModel: 0, waiting: 0, working: 0 }, false],
      [{ enabled: false, waiting: 0, working: 0 }, false],
    ] as const) {
      view(answer);
      await screen.findByText(/DJ mix/, { selector: 'p.text-paper-dim' });
      expect(!!button(), JSON.stringify(answer)).toBe(shown);
      cleanup();
    }
    const { analyzed } = view({ ready: 5678, beatModel: 5678, failed: 0, waiting: 0, working: 0 });
    analyzed.answer = () => json({ queued: 5678 });
    fireEvent.click(await screen.findByRole('button', { name: 'Analyse all again' }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Analysing 5,678 songs again in the background']));
    expect(analyzed.bodies).toEqual([{ again: true }]);
  });

  it('says how many songs were analysed without the beat model', async () => {
    usePrefs.setState({ transitions: 'dj' });
    view({ ready: 1234, beatModel: 1200 });
    expect(await screen.findByText(/^Ready for DJ mix: 1,234 of 5,678 songs \(34 without the beat model\)/)).toBeTruthy();
  });

  it('shows the server’s reason when the analysis can’t start', async () => {
    usePrefs.setState({ transitions: 'dj' });
    const { analyzed } = view({ waiting: 0, working: 0 });
    analyzed.answer = () => json({ error: 'Settings can only be changed from your home network' }, 403);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyse all songs now' }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => [t.message, t.tone])).toEqual([['Settings can only be changed from your home network', 'error']]),
    );
  });
});
