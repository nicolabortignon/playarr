import type { Track } from '@playarr/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOffline, type Download } from '../player/offline';
import { OfflineMark } from './OfflineMark';

const kept = (fileId: number) => ({ url: `/stream/${fileId}`, bytes: 1000, usedAt: 0 });
const MEZZANINE: Download = { key: 'album:7', title: 'Mezzanine', href: '/albums/7', tracks: [{ fileId: 1 }, { fileId: 3 }] as Track[], addedAt: 0 };

beforeEach(() => {
  // Song 1 downloaded with its album; song 2 only loaded ahead as it played.
  useOffline.setState({ songs: { 1: kept(1), 2: kept(2) }, pins: { [MEZZANINE.key]: MEZZANINE }, active: null });
});
afterEach(() => {
  cleanup();
  useOffline.setState({ songs: {}, pins: {}, active: null });
});

describe('OfflineMark', () => {
  it('marks a song you downloaded as on this device', () => {
    render(<OfflineMark fileId={1} />);
    expect(screen.getByRole('img', { name: 'On this device' })).toBeTruthy();
  });

  it('leaves a song only loaded ahead unmarked, though it’s on the device too', () => {
    const { container } = render(<OfflineMark fileId={2} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a download’s progress, but not a song loading ahead', () => {
    useOffline.setState({ active: { fileId: 3, loaded: 50, total: 100 } });
    render(<OfflineMark fileId={3} />);
    expect(screen.getByRole('img', { name: 'Downloading, 50%' })).toBeTruthy();
    cleanup();
    useOffline.setState({ active: { fileId: 4, loaded: 50, total: 100 } });
    const { container } = render(<OfflineMark fileId={4} />);
    expect(container.innerHTML).toBe('');
  });
});
