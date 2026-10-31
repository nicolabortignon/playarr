import type { TrackMetadata } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useUI } from '../lib/ui';
import { describeFormat, TrackMetadataDialog } from './TrackMetadataDialog';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const FLAC = { codec: 'FLAC', container: 'flac', bits: 24, sampleRate: 96000, channels: 2, lossless: true };

const meta = (over: Partial<TrackMetadata> = {}): TrackMetadata => ({
  trackId: 700,
  title: 'Angel',
  artistName: 'Massive Attack',
  albumTitle: 'Mezzanine',
  trackNumber: 1,
  discNumber: 1,
  duration: 379,
  explicit: false,
  recordingId: '8e74dd9d-e5a3-4acd-918a-c36a0f8cda84',
  albumId: 70,
  albumType: 'Album',
  secondaryTypes: [],
  genres: ['trip hop'],
  artistId: 7,
  copies: [
    {
      fileId: 1,
      playing: true,
      source: { id: 1, name: 'Lidarr', kind: 'lidarr', location: 'Lidarr' },
      path: '/data/media/music/Massive Attack/Mezzanine/01 Angel.flac',
      size: 40_000_000,
      format: FLAC,
    },
    {
      fileId: 2,
      playing: false,
      source: { id: 2, name: 'NAS', kind: 'folder', location: 'This server' },
      path: '/host/volume2/data/old/Angel.mp3',
      size: 9_000_000,
      format: { codec: 'MP3', container: 'mp3', bitrate: 320, lossless: false },
      tags: { title: 'Angel (Remaster)', genres: [] },
      match: { state: 'auto', score: 0.93 },
    },
  ],
  pathsHidden: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUI.setState({ metadataTrackId: null });
});

function open(data: TrackMetadata) {
  vi.spyOn(api, 'trackMetadata').mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TrackMetadataDialog />
    </QueryClientProvider>,
  );
  act(() => useUI.getState().showMetadata(700));
}

describe('TrackMetadataDialog', () => {
  it('shows every file with its full path, which one plays, and how folder files were identified', async () => {
    open(meta());
    expect(await screen.findByText('/data/media/music/Massive Attack/Mezzanine/01 Angel.flac')).toBeTruthy();
    expect(screen.getByText('/host/volume2/data/old/Angel.mp3')).toBeTruthy();
    expect(screen.getByText('Files (2)')).toBeTruthy();
    expect(screen.getAllByText(/Plays/)).toHaveLength(1);
    expect(screen.getByText(/Matched on MusicBrainz automatically \(93%\)/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /8e74dd9d/ }).getAttribute('href')).toBe(
      'https://musicbrainz.org/recording/8e74dd9d-e5a3-4acd-918a-c36a0f8cda84',
    );
  });

  it('says why paths are missing away from home', async () => {
    const away = meta({ pathsHidden: true });
    away.copies = away.copies.map(({ path: _p, ...c }) => ({ ...c, source: { ...c.source, location: undefined } }));
    open(away);
    expect(await screen.findByText(/shown on your home network only/)).toBeTruthy();
    expect(screen.queryByText(/\/host\/volume2/)).toBeNull();
  });

  it('describes formats', () => {
    expect(describeFormat(FLAC)).toBe('FLAC · 24-bit / 96 kHz · stereo · lossless');
    expect(describeFormat({ codec: 'MP3', container: 'mp3', bitrate: 320, lossless: false })).toBe('MP3 · 320 kbps · lossy');
  });
});
