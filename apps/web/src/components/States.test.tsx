import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Heart } from 'lucide-react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, InlineError } from './States';

afterEach(cleanup);

const show = (element: ReactNode) => render(<RouterProvider router={createMemoryRouter([{ path: '/', element }])} />);

describe('ErrorState', () => {
  it('says the needle skipped, why, and offers to try again and a way home', () => {
    const retry = vi.fn();
    show(<ErrorState error={new Error('Lidarr is down')} onRetry={retry} />);
    // docs/design.md, The lines: a page that failed.
    expect(screen.getByText('The needle skipped.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Lidarr is down');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/');
  });
});

describe('EmptyState', () => {
  it('says what goes here in one line, and offers what fills it', () => {
    show(<EmptyState icon={Heart} title="No hearts yet." hint="Heart a song and it lands here." action={{ label: 'Browse albums', to: '/albums' }} />);
    expect(screen.getByText('No hearts yet.')).toBeTruthy();
    expect(screen.getByText('Heart a song and it lands here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse albums' }).getAttribute('href')).toBe('/albums');
  });

  it('puts a second action beside the first, outlined, saying more in its title', () => {
    const jump = vi.fn();
    show(<EmptyState icon={Heart} title="The deck’s empty." action="lucky" secondary={{ label: 'Jump back in', title: 'Plays “Mezzanine”', onClick: jump }} />);
    const lucky = screen.getByRole('button', { name: 'Feeling lucky' });
    const second = screen.getByRole('button', { name: 'Jump back in' });
    expect(second.getAttribute('title')).toBe('Plays “Mezzanine”');
    // Primary first, then the outlined one.
    expect(lucky.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lucky.className).toContain('bg-accent');
    expect(second.className).toContain('border');
    fireEvent.click(second);
    expect(jump).toHaveBeenCalled();
  });

  it('runs a button action', () => {
    const make = vi.fn();
    show(<EmptyState icon={Heart} title="No playlists yet." action={{ label: 'New playlist', onClick: make }} />);
    fireEvent.click(screen.getByRole('button', { name: 'New playlist' }));
    expect(make).toHaveBeenCalled();
  });
});

describe('InlineError', () => {
  it('says what happened and why, with Try again when there’s a retry', () => {
    const retry = vi.fn();
    show(
      <InlineError error={new Error('timed out')} onRetry={retry}>
        Couldn’t reach ListenBrainz
      </InlineError>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t reach ListenBrainz: timed out');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });

  it('has no Try again without a retry, and says the retry is under way', () => {
    show(<InlineError error="Wrong password" />);
    expect(screen.getByRole('alert').textContent).toContain('Wrong password');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    show(<InlineError error="Offline" onRetry={() => {}} retrying />);
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeTruthy();
  });
});
