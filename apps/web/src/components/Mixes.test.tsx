import type { MixDetail, MixSettingsInfo, MixSummary, Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { changesLabel, MixPage } from '../pages/Mix';
import { usePlayer } from '../player/store';
import { MixCard } from './Mixes';
import { MixesPanel } from './MixesPanel';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', trackNumber: 1, discNumber: 1, duration: 200, explicit: false, streamUrl: `/stream/${id}` }) as Track;

const mix: MixSummary = {
  key: 'vibes',
  kind: 'vibes',
  title: 'Vibes of the hour',
  subtitle: 'Your 9 PM sound',
  description: 'What you usually play around 9 PM.',
  trackCount: 2,
  duration: 400,
  covers: ['/art/album/1/cover'],
  hue: 265,
  generatedAt: '2026-11-01T21:00:00Z',
  refreshesAt: '2026-11-01T22:00:00Z',
};
const detail: MixDetail = { ...mix, tracks: [track(1), track(2)] };

const settings: MixSettingsInfo = {
  enabled: {},
  length: 50,
  adventurous: 0.5,
  blastDays: 90,
  genreMixes: 3,
  decadeMixes: 2,
  recordHistory: true,
  analyzeLibrary: false,
  analysisAvailable: true,
  history: { plays: 42, since: '2026-10-01T10:00:00Z' },
};

function renderAt(path: string, routes: { path: string; element: React.ReactNode }[]) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => usePlayer.setState({ queue: [], order: [], pos: -1, playing: false }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('mixes', () => {
  it('a mix card shows its name on the cover and opens the mix', () => {
    const router = renderAt('/', [
      { path: '/', element: <MixCard mix={mix} /> },
      { path: '/mixes/:key', element: <p>mix page</p> },
    ]);
    expect(screen.getByText('Vibes of the hour')).toBeTruthy();
    fireEvent.click(screen.getByText('Your 9 PM sound'));
    expect(router.state.location.pathname).toBe('/mixes/vibes');
  });

  it('the mix page plays the mix, draws a new one, and saves it as a playlist', async () => {
    vi.spyOn(api, 'mix').mockResolvedValue(detail);
    const regenerate = vi.spyOn(api, 'regenerateMix').mockResolvedValue({ ...detail, tracks: [track(3), track(4)] });
    const save = vi.spyOn(api, 'saveMix').mockResolvedValue({ id: 9, name: 'Vibes of the hour · 1 Nov' } as never);
    renderAt('/mixes/vibes', [{ path: '/mixes/:key', element: <MixPage /> }]);
    expect(await screen.findByRole('heading', { name: 'Vibes of the hour' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play Vibes of the hour' }));
    expect(usePlayer.getState().queue.map((t) => t.id)).toEqual([1, 2]);
    fireEvent.click(screen.getByRole('button', { name: /new mix/i }));
    await waitFor(() => expect(regenerate).toHaveBeenCalledWith('vibes'));
    expect(await screen.findByText('Song 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mix actions' }));
    fireEvent.click(await screen.findByText('Save as playlist'));
    await waitFor(() => expect(save).toHaveBeenCalledWith('vibes'));
  });

  it('says when a mix changes', () => {
    const now = Date.parse('2026-11-01T21:20:00Z');
    expect(changesLabel('2026-11-01T22:00:00Z', now)).toBe('Changes in 40 min');
    expect(changesLabel('2026-11-02T06:00:00Z', now)).toBe('Changes in 9 h');
  });
});

describe('MixesPanel', () => {
  it('turns kinds of mix on and off, and changes how they are made', async () => {
    vi.spyOn(api, 'mixSettings').mockResolvedValue(settings);
    const saveSettings = vi.spyOn(api, 'saveMixSettings').mockImplementation(async (patch) => ({ ...settings, ...patch, enabled: { ...settings.enabled, ...patch.enabled } }));
    renderAt('/', [{ path: '/', element: <MixesPanel /> }]);
    fireEvent.click(await screen.findByRole('switch', { name: 'Deep focus' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ enabled: { focus: false } }));
    fireEvent.click(screen.getByRole('radio', { name: 'Adventurous' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ adventurous: 1 }));
    expect(screen.getByText(/42 songs played since/)).toBeTruthy();
  });

  it('asks before clearing the listening history', async () => {
    vi.spyOn(api, 'mixSettings').mockResolvedValue(settings);
    const clear = vi.spyOn(api, 'clearHistory').mockResolvedValue({ ...settings, history: { plays: 0 } });
    renderAt('/', [{ path: '/', element: <MixesPanel /> }]);
    fireEvent.click(await screen.findByRole('button', { name: /clear history/i }));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect(await screen.findByText('Nothing played yet')).toBeTruthy();
  });
});
