import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisProgress } from '../lib/api';
import { useToasts } from '../lib/toast';
import { AnalysisPanel } from './AnalysisPanel';

const PROGRESS: AnalysisProgress = {
  enabled: true,
  songs: 5678,
  beats: { ready: 1234, beatModel: 1234, failed: 3 },
  sound: { ready: 2000, failed: 2 },
  tags: { ready: 4000, songs: 5000 },
  waiting: 4400,
  working: 1,
  tagsWaiting: 0,
  libraryScan: true,
};
const IDLE = { waiting: 0, working: 0, tagsWaiting: 0 };
const ALL_DONE: Partial<AnalysisProgress> = {
  ...IDLE,
  beats: { ready: 5678, beatModel: 5678, failed: 0 },
  sound: { ready: 5678, failed: 0 },
  tags: { ready: 5000, songs: 5000 },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The panel against a fake server answering each progress request with the next of `answers` (the
 * last one repeats), the analyses with `ran`, and the background switch's settings with `settings`.
 */
/** Settings answer 403, as they do away from the home network. */
let away = false;

function view(...answers: Partial<AnalysisProgress>[]) {
  const asked: string[] = [];
  const ran: { answer: () => Response | Promise<Response>; calls: { url: string; body: unknown }[] } = {
    answer: () => json({ queued: 4400 }),
    calls: [],
  };
  const settings = {
    answer: () =>
      away ? json({ error: 'Settings can only be seen from your home network' }, 403) : json({ analyzeLibrary: true, analysisAvailable: true }),
    saved: [] as unknown[],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/analysis/') && init?.method === 'POST') {
        ran.calls.push({ url, body: JSON.parse(String(init.body)) });
        return ran.answer();
      }
      if (url === '/api/settings/mixes') {
        if (init?.method === 'PUT') settings.saved.push(JSON.parse(String(init.body)));
        return settings.answer();
      }
      asked.push(url);
      return json({ ...PROGRESS, ...(answers[Math.min(asked.length, answers.length) - 1] ?? {}) });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AnalysisPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { asked, ran, settings };
}

const section = (title: string) => within(screen.getByRole('region', { name: title }));
const findSection = async (title: string) => within(await screen.findByRole('region', { name: title }));

afterEach(() => {
  away = false;
  cleanup();
  useToasts.setState({ toasts: [] });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AnalysisPanel', () => {
  it('shows each analysis’s progress over the library, and what’s under way', async () => {
    view();
    expect(await screen.findByText('Ready for DJ mix: 1,234 of 5,678 songs · 3 couldn’t be analysed.')).toBeTruthy();
    expect(screen.getByText('Measured: 2,000 of 5,678 songs · 2 couldn’t be measured.')).toBeTruthy();
    expect(screen.getByText('Looked up: 4,000 of 5,000 songs matched on MusicBrainz (678 more aren’t matched on MusicBrainz).')).toBeTruthy();
    expect(screen.getByText('Now: analysing 1 song · 4,400 waiting to be analysed.')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Songs ready for DJ mix' }).getAttribute('aria-valuenow')).toBe('1234');
    expect(screen.getByRole('meter', { name: 'Songs looked up' }).getAttribute('aria-valuemax')).toBe('5000');
  });

  it('says when every song is done', async () => {
    view(ALL_DONE);
    expect(await screen.findByText('All 5,678 songs are ready for DJ mix.')).toBeTruthy();
    expect(screen.getByText('All 5,678 songs are measured.')).toBeTruthy();
    expect(screen.getByText('All 5,000 songs matched on MusicBrainz are looked up (678 more aren’t matched on MusicBrainz).')).toBeTruthy();
    expect(screen.getByText('Nothing is being analysed right now.')).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('says songs are analysed as they come up when the library isn’t analysed as a whole', async () => {
    view({ libraryScan: false });
    expect(await screen.findByText(/^Ready for DJ mix: 1,234 of 5,678 songs · 3 couldn’t be analysed\. Others are analysed as they come up to play\.$/)).toBeTruthy();
  });

  it('says how many songs were analysed without the beat model', async () => {
    view({ beats: { ready: 1234, beatModel: 1200, failed: 0 } });
    expect(await screen.findByText(/^Ready for DJ mix: 1,234 of 5,678 songs \(34 without the beat model\)/)).toBeTruthy();
  });

  it('still looks tags up when audio analysis is off, and says why the rest can’t run', async () => {
    view({ ...IDLE, enabled: false });
    expect(await screen.findByText('DJ mix needs it. Audio analysis is off on this server (set ANALYSIS=on in its .env).')).toBeTruthy();
    expect(section('Beat analysis').queryByRole('button')).toBeNull();
    expect(section('Sound analysis').queryByRole('button')).toBeNull();
    expect(section('Tag lookup').getByRole('button', { name: 'Look up all songs now' })).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Analyse every song in the library' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks again while songs are being analysed, and stops once none are left', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { asked } = view({}, ALL_DONE);
    await screen.findByText(/4,400 waiting/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await screen.findByText('All 5,678 songs are ready for DJ mix.')).toBeTruthy();
    expect(asked).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(2);
  });

  it('offers to analyse the songs not done yet, but not while songs are being analysed, all are done, or the rest failed lately', async () => {
    const button = () => section('Beat analysis').queryByRole('button', { name: 'Analyse all songs now' });
    for (const [answer, shown] of [
      [IDLE, true],
      [{ ...IDLE, working: 1 }, false],
      [{ ...IDLE, waiting: 3 }, false],
      [ALL_DONE, false],
      // They're tried again tomorrow: there's nothing to start now.
      [{ ...IDLE, beats: { ready: 5675, beatModel: 5675, failed: 3 } }, false],
    ] as const) {
      view(answer);
      await screen.findByText(/DJ mix/, { selector: 'p.text-paper-dim' });
      expect(!!button(), JSON.stringify(answer)).toBe(shown);
      cleanup();
    }
  });

  it.each([
    ['Beat analysis', 'Analyse all songs now', '/api/analysis/beats'],
    ['Sound analysis', 'Analyse all songs now', '/api/analysis/sound'],
    ['Tag lookup', 'Look up all songs now', '/api/analysis/tags'],
  ])('runs %s on the songs not done yet, says how many, and follows it from then on', async (title, label, url) => {
    const { asked, ran } = view(IDLE, { waiting: 4400, working: 1, tagsWaiting: 4400 });
    let answer!: (response: Response) => void;
    ran.answer = () => new Promise((resolve) => (answer = resolve));
    const button = await (await findSection(title)).findByRole('button', { name: label });
    fireEvent.click(button);
    // One press at a time.
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    answer(json({ queued: 4400 }));
    const doing = title === 'Tag lookup' ? 'Looking up' : 'Analysing';
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toEqual([`${doing} 4,400 songs in the background`]));
    expect(ran.calls).toEqual([{ url, body: { again: false } }]);
    // The progress is asked again at once.
    await waitFor(() => expect(asked).toHaveLength(2));
  });

  it('runs an analysis on every song again whenever nothing of it is under way', async () => {
    const { ran } = view(ALL_DONE);
    ran.answer = () => json({ queued: 5678 });
    fireEvent.click(await (await findSection('Sound analysis')).findByRole('button', { name: 'Analyse all again' }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Analysing 5,678 songs again in the background']));
    expect(ran.calls).toEqual([{ url: '/api/analysis/sound', body: { again: true } }]);
    // Tag lookups waiting don't hold up the audio analyses, nor the other way round.
    cleanup();
    view({ ...ALL_DONE, tagsWaiting: 5 });
    expect(await (await findSection('Beat analysis')).findByRole('button', { name: 'Analyse all again' })).toBeTruthy();
    expect(section('Tag lookup').queryByRole('button', { name: 'Look up all again' })).toBeNull();
  });

  it('shows the server’s reason when an analysis can’t start', async () => {
    const { ran } = view(IDLE);
    ran.answer = () => json({ error: 'Settings can only be changed from your home network' }, 403);
    fireEvent.click(await (await findSection('Beat analysis')).findByRole('button', { name: 'Analyse all songs now' }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => [t.message, t.tone])).toEqual([['Settings can only be changed from your home network', 'error']]),
    );
  });

  it('turns the whole library’s analysis on and off', async () => {
    const { settings } = view(IDLE);
    const toggle = await screen.findByRole('switch', { name: 'Analyse every song in the library' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(settings.saved).toEqual([{ analyzeLibrary: false }]));
  });

  it('shows progress but no switch or buttons away from home', async () => {
    away = true;
    view(IDLE);
    expect(await screen.findByText('Analyses can be started from your home network.')).toBeTruthy();
    expect(screen.getByText(/^Ready for DJ mix/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
