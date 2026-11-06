import type { TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useBlend } from '../player/blend';
import { setPulseSource } from '../player/pulse';
import { usePlayer } from '../player/store';
import { MiniPlayer, PlayerBar } from './PlayerBar';

const track = (id: number, title: string, coverColor: string) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title, artistName: 'Massive Attack', albumTitle: title, duration: 300, coverUrl: `/art/album/${id}/cover`, coverColor }) as Track;
const sourTimes = track(1, 'Sour Times', '#3a2a1a');
const teardrop = track(2, 'Teardrop', '#1a2a3a');

/** A 16 s blend: Teardrop comes in over the first 8 s, Sour Times goes over the last 8. */
const plan = {
  style: 'long',
  aStart: 280,
  length: 20,
  aGain: [
    { at: 0, value: 1 },
    { at: 8, value: 1 },
    { at: 16, value: 0 },
  ],
  bGain: [
    { at: 0, value: 0 },
    { at: 8, value: 1 },
  ],
} as Partial<TransitionPlan> as TransitionPlan;

/** How far into the transition the engine says the music is (seconds). */
let into = 4;

function view(player = <MiniPlayer />) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{player}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const layer = (role: string) => document.querySelector<HTMLElement>(`[data-cover="${role}"]`);
const opacity = (role: string) => Number(layer(role)?.style.opacity);
/** Whose cover a layer shows, by the cover's own color filling its space. */
const colorOf = (role: string) => layer(role)!.querySelector<HTMLElement>('.aspect-square')!.style.backgroundColor;

beforeEach(() => {
  into = 4;
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  usePrefs.setState({ motion: 'full' });
  usePlayer.setState({ queue: [sourTimes, teardrop], order: [0, 1], pos: 0, playing: true });
  useBlend.setState({ blend: null });
  setPulseSource({ songTime: () => plan.aStart + into, meter: () => null, blend: () => ({ plan, time: into }) });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setPulseSource(null);
  useBlend.setState({ blend: null });
});

describe('a DJ blend in the mini player', () => {
  it('shows both covers overlapping, cross-fading as the songs do', async () => {
    view();
    expect(layer('alone')).not.toBeNull();
    act(() => useBlend.setState({ blend: { from: sourTimes, to: teardrop, plan } }));
    // The song being left above and to the left, the one coming in below and to the right.
    expect(layer('from')!.className).toContain('origin-top-left');
    expect(layer('to')!.className).toContain('origin-bottom-right');
    expect(['#3a2a1a', 'rgb(58, 42, 26)']).toContain(colorOf('from'));
    expect(['#1a2a3a', 'rgb(26, 42, 58)']).toContain(colorOf('to'));
    // 4 s in, Teardrop is half in; Sour Times still all there.
    await waitFor(() => expect(opacity('to')).toBeCloseTo(0.5, 6));
    expect(opacity('from')).toBe(1);
    // 12 s in, Sour Times is half gone.
    into = 12;
    await waitFor(() => expect(opacity('from')).toBeCloseTo(0.5, 6));
    expect(opacity('to')).toBe(1);
    // Over: Teardrop alone, back to the whole cover, the same picture kept.
    const coming = layer('to');
    act(() => {
      useBlend.setState({ blend: null });
      usePlayer.setState({ pos: 1 });
    });
    expect(layer('alone')).toBe(coming);
    expect(layer('alone')!.className).toContain('scale-100');
    expect(layer('from')).toBeNull();
  });

  it('stays where the mix is while paused', () => {
    usePlayer.setState({ playing: false });
    into = 12;
    view();
    act(() => useBlend.setState({ blend: { from: sourTimes, to: teardrop, plan } }));
    expect(opacity('from')).toBeCloseTo(0.5, 6);
    expect(opacity('to')).toBe(1);
  });

  it('shows the blend in the player bar too', () => {
    view(<PlayerBar />);
    act(() => useBlend.setState({ blend: { from: sourTimes, to: teardrop, plan } }));
    const open = screen.getByRole('button', { name: 'Open now playing' });
    expect(open.querySelector('[data-blend]')).not.toBeNull();
    expect(open.querySelectorAll('[data-cover]')).toHaveLength(2);
  });

  it('just sits the two covers together under Reduce Motion, without following the mix', async () => {
    usePrefs.setState({ motion: 'reduce' });
    const read = vi.fn(() => ({ plan, time: into }));
    setPulseSource({ songTime: () => 0, meter: () => null, blend: read });
    view();
    act(() => useBlend.setState({ blend: { from: sourTimes, to: teardrop, plan } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(layer('from')).not.toBeNull();
    expect(layer('to')!.style.opacity).toBe('');
    expect(layer('from')!.style.opacity).toBe('');
    expect(read).not.toHaveBeenCalled();
  });
});
