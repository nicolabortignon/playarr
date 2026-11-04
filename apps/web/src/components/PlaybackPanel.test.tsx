import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefs } from '../lib/prefs';
import { PlaybackPanel } from './PlaybackPanel';

/** `me`: who's signed in, as /api/auth/me answers (by default nobody in particular, nothing locked). */
function view(me: object = {}) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(url === '/api/auth/me' ? me : {}), { headers: { 'content-type': 'application/json' } });
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

  it('points DJ mix to Settings → Analysis for how many songs are ready, without asking the server', () => {
    usePrefs.setState({ transitions: 'dj' });
    const { asked } = view();
    expect(screen.getByRole('link', { name: 'Settings → Analysis' }).getAttribute('href')).toBe('/settings/analysis');
    // Only who's signed in (whether an admin has locked Playback), nothing about the analysis.
    expect(asked).toEqual(['/api/auth/me']);
  });

  it('is read-only when an admin has locked Playback for this account', async () => {
    view({ id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true, locked: ['playback'] });
    expect(await screen.findByText('Only an admin can change Playback for your account.')).toBeTruthy();
    expect((screen.getByRole('switch', { name: /Keep playing when the queue ends/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(transitions().getByRole('radio', { name: 'DJ mix' }));
    expect(usePrefs.getState().transitions).toBe('off');
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
