import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePrefs } from '../lib/prefs';
import { playPausePath, PlayPauseIcon } from './PlayPauseIcon';

const PLAY = playPausePath(0);
const PAUSE = playPausePath(1);
const shape = () => document.querySelector('path')!;

/** Every shape the icon is drawn in, as it changes. */
function watchShapes() {
  const seen: string[] = [];
  const observer = new MutationObserver(() => seen.push(shape().getAttribute('d')!));
  observer.observe(shape(), { attributes: true, attributeFilter: ['d'] });
  return { seen, stop: () => observer.disconnect() };
}

beforeEach(() => usePrefs.setState({ motion: 'full' }));
afterEach(cleanup);

describe('Play and Pause', () => {
  it('are two halves of a triangle and two bars, corner for corner', () => {
    const numbers = (d: string) => d.match(/[\d.]+/g)!.map(Number);
    // Pause is lucide's: two bars 5 wide and 18 tall, 4 apart.
    const [l1x, l1y, l2x, , , l3y, , , r1x] = numbers(PAUSE);
    expect([l2x! - l1x!, l3y! - l1y!, r1x! - l2x!]).toEqual([5, 18, 4]);
    // Play's two halves meet where the triangle is cut, its tip doubled on the right.
    const play = numbers(PLAY);
    expect(play.slice(2, 4)).toEqual(play.slice(8, 10));
    expect(play.slice(10, 12)).toEqual(play.slice(12, 14));
    // Halfway, every corner is halfway between.
    const half = numbers(playPausePath(0.5));
    numbers(PAUSE).forEach((p, i) => expect(half[i]).toBeCloseTo((p + play[i]!) / 2, 1));
  });

  it('morph into each other rather than swapping: one shape, passing through those between', async () => {
    const { rerender } = render(<PlayPauseIcon playing={false} />);
    const path = shape();
    expect(path.getAttribute('d')).toBe(PLAY);
    const { seen, stop } = watchShapes();
    rerender(<PlayPauseIcon playing />);
    expect(path.hasAttribute('data-morphing')).toBe(true);
    await waitFor(() => expect(path.hasAttribute('data-morphing')).toBe(false));
    stop();
    expect(path.getAttribute('d')).toBe(PAUSE);
    expect(shape()).toBe(path);
    // On its way it was neither: the bars grew out of the triangle.
    expect(seen.filter((d) => d !== PLAY && d !== PAUSE).length).toBeGreaterThan(1);
  });

  it('turns back from where it is when pressed again halfway', async () => {
    const { rerender } = render(<PlayPauseIcon playing={false} />);
    rerender(<PlayPauseIcon playing />);
    await waitFor(() => expect([PLAY, PAUSE]).not.toContain(shape().getAttribute('d')));
    const halfway = shape().getAttribute('d');
    const { seen, stop } = watchShapes();
    rerender(<PlayPauseIcon playing={false} />);
    await waitFor(() => expect(shape().getAttribute('d')).toBe(PLAY));
    stop();
    // No jump to Pause first: back from the shape it had reached.
    expect(seen).not.toContain(PAUSE);
    expect(halfway).not.toBe(PLAY);
  });

  it('swap at once under Reduce Motion', () => {
    usePrefs.setState({ motion: 'reduce' });
    const { rerender } = render(<PlayPauseIcon playing={false} />);
    rerender(<PlayPauseIcon playing />);
    expect(shape().getAttribute('d')).toBe(PAUSE);
    expect(shape().hasAttribute('data-morphing')).toBe(false);
  });
});
