import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackButton, ErrorState } from './Section';

afterEach(cleanup);

describe('BackButton', () => {
  it('goes to the parent page when the page was opened directly', () => {
    const router = createMemoryRouter(
      [
        { path: '/albums/:id', element: <BackButton fallback="/artists/7" /> },
        { path: '/artists/:id', element: <p>artist</p> },
      ],
      { initialEntries: ['/albums/70'] },
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(router.state.location.pathname).toBe('/artists/7');
  });
});

describe('ErrorState', () => {
  it('offers to try again and a way home', () => {
    const retry = vi.fn();
    const router = createMemoryRouter([{ path: '/', element: <ErrorState error={new Error('Lidarr is down')} onRetry={retry} /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByText('Lidarr is down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back home' }).getAttribute('href')).toBe('/');
  });
});
