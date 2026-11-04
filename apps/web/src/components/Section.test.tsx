import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shelf } from './Section';

afterEach(cleanup);

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
