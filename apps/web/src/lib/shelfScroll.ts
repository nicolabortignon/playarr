/** Where a shelf (components/Section.tsx) scrolls to, from its arrows and from clicks on the line under it. */

/** The card edge nearest `goal` (scroll positions), or `goal` itself when there are no cards. */
export function nearestEdge(edges: number[], goal: number): number {
  return edges.reduce((best, edge) => (Math.abs(edge - goal) < Math.abs(best - goal) ? edge : best), edges[0] ?? goal);
}

/**
 * Where to scroll so the stretch in view is centred on a point clicked on the line, `at` (0–1) along it: the line
 * stands for the whole row, the stretch in view for what fits on screen.
 */
export function scrollForPoint(at: number, clientWidth: number, scrollWidth: number): number {
  const over = scrollWidth - clientWidth;
  if (over <= 0) return 0;
  const size = clientWidth / scrollWidth;
  const start = Math.min(1 - size, Math.max(0, at - size / 2));
  return (start / (1 - size)) * over;
}
