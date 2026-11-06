import type { Track } from '@playarr/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOffline, useOffline } from '../player/offline';
import { OfflineStorage } from './OfflineStorage';

// Keeping songs needs a secure context with Cache Storage, which the test browser lacks.
vi.mock('../player/offline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../player/offline')>()),
  canKeepOffline: true,
  clearOffline: vi.fn(async () => {}),
}));

const MB = 1024 ** 2;
const kept = (fileId: number) => ({ url: `/stream/${fileId}`, bytes: 100 * MB, usedAt: 0 });

beforeEach(() => {
  // Two songs of a download, and one saved as it played.
  const tracks = [{ fileId: 1 }, { fileId: 2 }] as Track[];
  useOffline.setState({ songs: { 1: kept(1), 2: kept(2), 3: kept(3) }, pins: { 'album:7': { key: 'album:7', title: 'Mezzanine', href: '/albums/7', tracks, addedAt: 0 } } });
});
afterEach(() => {
  cleanup();
  vi.mocked(clearOffline).mockClear();
  useOffline.setState({ songs: {}, pins: {} });
});

describe('OfflineStorage', () => {
  it('asks before removing everything from this device, saying how much goes', async () => {
    render(
      <MemoryRouter>
        <OfflineStorage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    const ask = await screen.findByRole('dialog', { name: 'Remove 3 songs from this device?' });
    expect(ask.textContent).toContain('1 download (200 MB) and 1 song saved as you listened (100 MB) leave this device.');
    expect(clearOffline).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove all' }));
    expect(clearOffline).toHaveBeenCalled();
  });
});
