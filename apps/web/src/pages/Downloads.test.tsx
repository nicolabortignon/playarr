import type { Track } from '@playarr/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOffline } from '../player/offline';
import { DownloadsPage } from './Downloads';

// Whether the page is secure, where browsers keep music: the test page itself is plain http.
const page = vi.hoisted(() => ({ secure: true }));
vi.mock('../player/offline', async (original) => {
  const real = await original<typeof import('../player/offline')>();
  return {
    ...real,
    get canKeepOffline() {
      return page.secure;
    },
  };
});

const track = (fileId: number) => ({ id: fileId, fileId, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}` }) as Track;
const view = () =>
  render(
    <MemoryRouter>
      <DownloadsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  page.secure = true;
  useOffline.setState({ songs: {}, pins: {} });
});
afterEach(cleanup);

describe('Downloads', () => {
  it('says nothing’s in the record bag yet, how to download, and offers albums to browse', () => {
    view();
    // docs/design.md, The lines: Downloads.
    expect(screen.getByText('Nothing in the record bag yet.')).toBeTruthy();
    expect(screen.getByText('Download an album, a playlist or a mix, and it plays here with or without a connection.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse albums' }).getAttribute('href')).toBe('/albums');
  });

  it('says why a browser without HTTPS can’t download', () => {
    page.secure = false;
    view();
    expect(screen.getByText('Downloads need a secure connection.')).toBeTruthy();
    expect(screen.getByText('Browsers only keep music on a device over HTTPS.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Browse albums' })).toBeNull();
  });

  it('lists a download with how far along it is', () => {
    useOffline.setState({
      pins: { 'album:70': { key: 'album:70', title: 'Mezzanine', subtitle: 'Massive Attack', href: '/albums/70', tracks: [track(1), track(2)], addedAt: 1 } },
      songs: { 1: { url: '/stream/1', bytes: 1000, usedAt: 1 } },
    });
    view();
    expect(screen.getByRole('link', { name: 'Mezzanine' })).toBeTruthy();
    expect(screen.getByText(/1 of 2 songs/)).toBeTruthy();
  });
});
