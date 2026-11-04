import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackButton, ErrorState, Shelf } from './Section';

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

/** A shelf four screens wide on a line 400 px long, scrolled to its start: the marker is the line's first quarter. */
function shelf() {
  const { container } = render(
    <Shelf>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i}>Album {i}</div>
      ))}
    </Shelf>,
  );
  const row = container.querySelector<HTMLDivElement>('.snap-x')!;
  const track = container.querySelector<HTMLDivElement>('.cursor-pointer')!;
  const line = track.firstElementChild as HTMLElement;
  const marker = line.firstElementChild as HTMLElement;
  Object.defineProperties(row, { clientWidth: { value: 400 }, scrollWidth: { value: 1600 } });
  line.getBoundingClientRect = () => new DOMRect(0, 0, 400, 1);
  marker.getBoundingClientRect = () => new DOMRect(0, 0, 100, 1);
  row.scrollTo = vi.fn() as typeof row.scrollTo;
  track.setPointerCapture = vi.fn();
  return { row, track };
}

describe('Shelf', () => {
  it('drags along the line holding the marker where it was grabbed, and stops snapping while dragged', () => {
    const { row, track } = shelf();
    fireEvent.pointerDown(track, { clientX: 20, button: 0, pointerId: 1 });
    expect(row.scrollTo).not.toHaveBeenCalled();
    expect(row.style.scrollSnapType).toBe('none');
    // Grabbed 30 px left of the marker's middle: moved to 220, the marker's middle is at 250, so the row is halfway.
    fireEvent.pointerMove(track, { clientX: 220, pointerId: 1 });
    expect(row.scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: 'instant' });
    fireEvent.pointerUp(track, { clientX: 220, pointerId: 1 });
    expect(row.style.scrollSnapType).toBe('');
    fireEvent.pointerMove(track, { clientX: 300, pointerId: 1 });
    expect(row.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('glides there when the line is pressed off the marker', () => {
    const { row, track } = shelf();
    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 });
    expect(row.scrollTo).toHaveBeenCalledWith({ left: 1000, behavior: 'smooth' });
  });
});
