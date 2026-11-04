import { describe, expect, it } from 'vitest';
import { nearestEdge, scrollForPoint } from './shelfScroll';

describe('shelf scrolling', () => {
  it('lands the arrows on the card edge nearest most of a screen along', () => {
    expect(nearestEdge([0, 176, 352, 528], 321)).toBe(352);
    expect(nearestEdge([0, 176, 352, 528], 250)).toBe(176);
    expect(nearestEdge([], 321)).toBe(321);
  });

  it('centres the part in view on the point clicked on the line, never past either end', () => {
    // A row four screens wide: the stretch in view is a quarter of the line.
    expect(scrollForPoint(0.5, 400, 1600)).toBe(600);
    expect(scrollForPoint(0.125, 400, 1600)).toBe(0);
    expect(scrollForPoint(0.05, 400, 1600)).toBe(0);
    expect(scrollForPoint(0.99, 400, 1600)).toBe(1200);
    expect(scrollForPoint(0.5, 400, 400)).toBe(0);
  });
});
