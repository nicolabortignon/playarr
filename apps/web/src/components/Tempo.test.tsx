import type { MixMap } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { TrackList } from './TrackList';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: 1, artistId: 1, title: `Song ${id}`, artistName: 'Artist', albumTitle: 'A', trackNumber: id, discNumber: 1, duration: 245, streamUrl: `/s/${id}` }) as Track;

const map = (bpm: number) => ({ bpm }) as MixMap;

function list(tracks: Track[]) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TrackList tracks={tracks} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (title: string) => screen.getByText(title).closest('li')!;

beforeEach(() => {
  vi.spyOn(api, 'mixMaps').mockImplementation(async (ids) =>
    Object.fromEntries(ids.flatMap((id) => (id === 'rec-2' ? [] : id === 'rec-3' ? [[id, map(0)]] : [[id, map(130.25)]]))),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Tempo in song lists', () => {
  it('shows each measured song’s BPM before its length, and nothing for a song not measured or without a beat', async () => {
    list([track(1), track(2), track(3)]);
    expect((await within(row('Song 1')).findByText('130.3')).title).toBe('130.25 BPM, as Playarr measured it');
    expect(within(row('Song 1')).getByText('4:05')).toBeTruthy();
    expect(within(row('Song 2')).queryByText(/\d+\.\d/)).toBeNull();
    expect(within(row('Song 3')).queryByText(/\d+\.\d/)).toBeNull();
  });

  it('asks for a long list’s tempos 50 songs at a time', async () => {
    list(Array.from({ length: 120 }, (_, i) => track(i + 1)));
    expect(await within(row('Song 120')).findByText('130.3')).toBeTruthy();
    expect(vi.mocked(api.mixMaps).mock.calls.map(([ids]) => ids.length)).toEqual([50, 50, 20]);
  });
});
