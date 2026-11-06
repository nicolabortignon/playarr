import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Heart } from 'lucide-react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, InlineError } from './States';

afterEach(cleanup);

const show = (element: ReactNode) => render(<RouterProvider router={createMemoryRouter([{ path: '/', element }])} />);

describe('ErrorState', () => {
  it('offers to try again and a way home', () => {
    const retry = vi.fn();
    show(<ErrorState error={new Error('Lidarr is down')} onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('Lidarr is down');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/');
  });
});

describe('EmptyState', () => {
  it('says what goes here in one line, and offers what fills it', () => {
    show(<EmptyState icon={Heart} title="Songs you heart land here." action={{ label: 'Find something to love', to: '/' }} />);
    expect(screen.getByText('Songs you heart land here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find something to love' }).getAttribute('href')).toBe('/');
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
