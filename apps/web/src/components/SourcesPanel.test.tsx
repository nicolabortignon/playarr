import type { SourceInfo } from '@playarr/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlbumSummary, MatchSummary } from './SourcesPanel';

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
  matched: 0,
  review: 0,
  ignored: 0,
  matching: 0,
  ...counts,
});

afterEach(cleanup);

describe('MatchSummary', () => {
  it('says how many albums matched, and opens the review from those that didn’t', () => {
    const onReview = vi.fn();
    render(<MatchSummary source={folder({ matched: 896, review: 546, ignored: 1 })} canEdit onReview={onReview} />);
    expect(screen.getByText('896 albums matched')).toBeTruthy();
    expect(screen.getByText('1 left as tagged')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '546 not matched' }));
    expect(onReview).toHaveBeenCalled();
  });

  it('only counts, without a way to review, for someone who can’t change settings', () => {
    render(<MatchSummary source={folder({ matched: 1, review: 2 })} canEdit={false} onReview={() => {}} />);
    expect(screen.getByText('1 album matched')).toBeTruthy();
    expect(screen.getByText('2 not matched')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows nothing before anything was matched', () => {
    const { container } = render(<MatchSummary source={folder({})} canEdit onReview={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('AlbumSummary', () => {
  it('says how many albums the source has whole, in part, or unidentified', () => {
    render(<AlbumSummary source={folder({ albumsComplete: 10, albumsIncomplete: 918, albumsUnknown: 511 })} />);
    expect(screen.getByText('10 Complete Albums · 918 Incomplete Albums · 511 Unidentified')).toBeTruthy();
  });

  it('leaves out what it has none of', () => {
    render(<AlbumSummary source={folder({ albumsComplete: 1, albumsIncomplete: 7 })} />);
    expect(screen.getByText('1 Complete Album · 7 Incomplete Albums')).toBeTruthy();
  });
});
