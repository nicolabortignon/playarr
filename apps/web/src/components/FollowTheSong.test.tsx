import type { MixMapEntry } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { usePlayer } from '../player/store';
import { FollowTheSong } from './AppShell';

vi.mock('../lib/favicon', () => ({ setFaviconAccent: vi.fn() }));

const track = (id: number, coverAccent: string) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, title: `Song ${id}`, duration: 300, coverUrl: `/art/album/${id}/cover`, coverColor: '#202020', coverAccent }) as Track;
const sourTimes = track(1, '#5b8fd9');
const teardrop = track(2, '#d95b5b');
/** Sour Times at 96 BPM, Teardrop at 120. */
const tempo: Record<string, number> = { 'rec-1': 96, 'rec-2': 120 };

const root = () => document.documentElement.style;

beforeEach(() => {
  usePrefs.setState({ accent: 'album', motion: 'full' });
  vi.spyOn(api, 'mixMaps').mockImplementation(async (ids) => Object.fromEntries(ids.map((id) => [id, { bpm: tempo[id], gridStable: true } as MixMapEntry])));
  usePlayer.setState({ queue: [sourTimes, teardrop], order: [0, 1], pos: 0, playing: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the accent following the song playing', () => {
  it('glides into the next song’s color over one beat of it, its tempo asked for ahead', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FollowTheSong />
      </QueryClientProvider>,
    );
    expect(root().getPropertyValue('--accent')).toBe('#5b8fd9');
    // Only the next song's tempo is asked for: the color of the song playing has come already.
    await waitFor(() => expect(api.mixMaps).toHaveBeenCalledWith(['rec-2']));
    expect(api.mixMaps).not.toHaveBeenCalledWith(['rec-1']);
    act(() => usePlayer.setState({ pos: 1 }));
    // Teardrop's color, over one beat at 120 BPM, the length set as the color changes.
    expect(root().getPropertyValue('--accent')).toBe('#d95b5b');
    expect(root().getPropertyValue('--accent-glide')).toBe('500ms');
  });
});
