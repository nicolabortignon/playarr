import type { Track } from '@playarr/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../lib/toast';
import { useOffline } from '../player/offline';
import { DownloadButton } from './DownloadButton';

// A secure page, where browsers keep music (the test page is plain http).
vi.mock('../player/offline', async (original) => ({ ...(await original<typeof import('../player/offline')>()), canKeepOffline: true }));

const track = (fileId: number) => ({ id: fileId, fileId, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}` }) as Track;
const kept = (...ids: number[]) => Object.fromEntries(ids.map((id) => [id, { url: `/stream/${id}`, bytes: 1000, usedAt: 1 }]));
const ITEM = { key: 'album:70', title: 'Mezzanine', href: '/albums/70' };
const messages = () => useToasts.getState().toasts.map((t) => t.message);

beforeEach(() => {
  useOffline.setState({ songs: {}, pins: {} });
  useToasts.setState({ toasts: [] });
});
afterEach(cleanup);

describe('Download', () => {
  it('says it’s downloading, and its ring fills as the songs arrive', () => {
    render(<DownloadButton item={ITEM} tracks={[track(1), track(2)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Mezzanine' }));
    expect(messages()).toEqual(['Downloading “Mezzanine”']);
    expect(screen.getByRole('button', { name: 'Downloading, 0 of 2: remove Mezzanine from this device' })).toBeTruthy();
  });

  it('says at once that an album already on the device is on it, closing into its tick', () => {
    useOffline.setState({ songs: kept(1, 2) });
    render(<DownloadButton item={ITEM} tracks={[track(1), track(2)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Mezzanine' }));
    expect(messages()).toEqual(['“Mezzanine” is on this device']);
    expect(screen.getByRole('button', { name: 'Downloaded: remove Mezzanine from this device' })).toBeTruthy();
  });
});
