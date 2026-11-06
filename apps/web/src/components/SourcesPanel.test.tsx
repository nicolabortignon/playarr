import type { SourceInfo } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { AlbumSummary, MatchSummary, SourcesPanel } from './SourcesPanel';

const folder = (counts: Partial<SourceInfo>): SourceInfo => ({
  id: 2,
  kind: 'folder',
  name: 'BotB',
  position: 1,
  enabled: true,
  secrets: [],
  syncing: false,
  songs: 1501,
  albums: 1400,
  albumsComplete: 0,
  albumsIncomplete: 0,
  albumsUnknown: 0,
  songsComplete: 0,
  songsIncomplete: 0,
  songsUnknown: 0,
  matched: 0,
  review: 0,
  ignored: 0,
  matching: 0,
  ...counts,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MatchSummary', () => {
  it('says how many songs matched, and opens the review from those that didn’t', () => {
    const onReview = vi.fn();
    render(<MatchSummary source={folder({ matched: 896, review: 546, ignored: 1 })} canEdit onReview={onReview} />);
    expect(screen.getByText('896 songs matched')).toBeTruthy();
    expect(screen.getByText('1 left as tagged')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '546 not matched' }));
    expect(onReview).toHaveBeenCalled();
  });

  it('only counts, without a way to review, for someone who can’t change settings', () => {
    render(<MatchSummary source={folder({ matched: 1, review: 2 })} canEdit={false} onReview={() => {}} />);
    expect(screen.getByText('1 song matched')).toBeTruthy();
    expect(screen.getByText('2 not matched')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows nothing before anything was matched', () => {
    const { container } = render(<MatchSummary source={folder({})} canEdit onReview={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('AlbumSummary', () => {
  const counters = () => screen.getAllByRole('listitem').map((li) => li.textContent);

  it('counts Lidarr’s albums complete, incomplete and unidentified, each on its own', () => {
    render(<AlbumSummary source={folder({ kind: 'lidarr', albumsComplete: 10, albumsIncomplete: 918, albumsUnknown: 511 })} />);
    expect(counters()).toEqual(['10Complete albums', '918Incomplete albums', '511Unidentified']);
  });

  it('shows every counter, at none too, and one album in the singular', () => {
    render(<AlbumSummary source={folder({ kind: 'lidarr', albumsComplete: 1 })} />);
    expect(counters()).toEqual(['1Complete album', '0Incomplete albums', '0Unidentified']);
  });

  it('counts a folder’s songs, adding up to all of them, the unidentified as many as not matched', () => {
    render(<AlbumSummary source={folder({ songs: 100, albums: 86, songsComplete: 3, songsIncomplete: 92, songsUnknown: 5, review: 5 })} />);
    expect(counters()).toEqual(['3On complete albums', '92On incomplete albums', '5Unidentified']);
  });

  it('shows nothing for a source without albums', () => {
    const { container } = render(<AlbumSummary source={folder({ albums: 0 })} />);
    expect(container.textContent).toBe('');
  });
});

describe('SourcesPanel', () => {
  const LIDARR = { ...folder({}), id: 1, kind: 'lidarr', name: 'Lidarr', settings: { url: 'http://nas:8686' } } as SourceInfo;
  const MUSIC = {
    ...folder({ songs: 1501, albums: 1400 }),
    id: 2,
    name: 'Music',
    settings: { path: '/volume2/music/a very long folder name that a phone would cut short', access: 'local' },
  } as SourceInfo;

  function view() {
    vi.spyOn(api, 'sources').mockResolvedValue({ sources: [LIDARR, MUSIC], canEdit: true });
    vi.spyOn(api, 'matching').mockResolvedValue({ acoustid: false, fingerprints: true } as never);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SourcesPanel />
      </QueryClientProvider>,
    );
  }
  const menuItems = () => within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);

  it('shows where a source is in full, and its counts', async () => {
    view();
    const row = (await screen.findByText(MUSIC.settings!.path!)).closest('li')!;
    expect(within(row).getByText('1501 songs · 1400 albums')).toBeTruthy();
  });

  it('puts a source’s actions in its ⋯, in words, Remove last', async () => {
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'More for Music' }));
    expect(menuItems()).toEqual(['Sync now', 'Match again', 'Organize files', 'Edit', 'Move up', 'Remove']);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Lidarr' }));
    expect(menuItems()).toEqual(['Sync now', 'Edit', 'Move down', 'Remove']);
  });

  it('syncs a source now, and moves it from the keyboard as dragging would', async () => {
    const sync = vi.spyOn(api, 'rescanSource').mockResolvedValue();
    const reorder = vi.spyOn(api, 'reorderSources').mockResolvedValue({ sources: [MUSIC, LIDARR], canEdit: true });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'More for Music' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync now' }));
    await waitFor(() => expect(sync.mock.calls[0]?.[0]).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'More for Music' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(reorder.mock.calls[0]?.[0]).toEqual([2, 1]));
  });
});
