import type { Track } from '@playarr/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useToasts } from '../lib/toast';
import { justDownloaded, useDownloads } from './downloads';
import { type Download, useOffline } from './offline';

const track = (fileId: number) => ({ id: fileId, fileId, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}` }) as Track;
const kept = (...ids: number[]) => Object.fromEntries(ids.map((id) => [id, { url: `/stream/${id}`, bytes: 1000, usedAt: 1 }]));
const MEZZANINE: Download = { key: 'album:70', title: 'Mezzanine', href: '/albums/70', tracks: [track(1), track(2)], addedAt: 1 };

beforeEach(() => {
  useOffline.setState({ songs: {}, pins: {} });
  useToasts.setState({ toasts: [] });
});
afterEach(cleanup);

describe('a finished download', () => {
  it('is one whose last song just arrived, not one whole as it’s added or put back', () => {
    const pins = { [MEZZANINE.key]: MEZZANINE };
    expect(justDownloaded({ pins, songs: kept(1) }, { pins, songs: kept(1, 2) })).toEqual([MEZZANINE]);
    expect(justDownloaded({ pins, songs: kept(1) }, { pins, songs: kept(1) })).toEqual([]);
    // Added (or restored by an Undo) with every song on the device already: its button says so.
    expect(justDownloaded({ pins: {}, songs: kept(1, 2) }, { pins, songs: kept(1, 2) })).toEqual([]);
    // Done before, done still.
    expect(justDownloaded({ pins, songs: kept(1, 2) }, { pins, songs: kept(1, 2, 3) })).toEqual([]);
  });

  it('says so in a toast once its ring has closed: “Mezzanine” is on this device', () => {
    renderHook(() => useDownloads());
    act(() => useOffline.setState({ pins: { [MEZZANINE.key]: MEZZANINE }, songs: kept(1) }));
    expect(useToasts.getState().toasts).toEqual([]);
    act(() => useOffline.setState({ songs: kept(1, 2) }));
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['“Mezzanine” is on this device']);
  });

  it('says so again when a downloaded playlist’s new songs have arrived', () => {
    const playlist: Download = { key: 'playlist:5', title: 'Late night', href: '/playlists/5', tracks: [track(1)], addedAt: 1 };
    useOffline.setState({ pins: { [playlist.key]: playlist }, songs: kept(1) });
    renderHook(() => useDownloads());
    act(() => useOffline.setState({ pins: { [playlist.key]: { ...playlist, tracks: [track(1), track(3)] } } }));
    expect(useToasts.getState().toasts).toEqual([]);
    act(() => useOffline.setState({ songs: kept(1, 3) }));
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['“Late night” is on this device']);
  });
});
