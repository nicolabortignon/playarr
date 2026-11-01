import type { Automation } from './types.ts';

// Automation curves are shared by the planner (which writes them) and the renderer
// (which reads them sample by sample), so both must agree on what a curve means:
// straight lines between points, held flat before the first and after the last point.
// Points are in time order; two points at the same time make a step.

/** The curve's value at time t (seconds into the transition). */
export function valueAt(automation: Automation, t: number): number {
  const first = automation[0];
  const last = automation[automation.length - 1];
  if (!first || !last) throw new RangeError('An automation needs at least one point');
  if (t < first.at) return first.value;
  if (t >= last.at) return last.value;
  // The last point at or before t; at a step this picks the later value, so steps take effect on time.
  let index = 0;
  while (index + 1 < automation.length && automation[index + 1]!.at <= t) index++;
  const from = automation[index]!;
  const to = automation[index + 1]!;
  const progress = (t - from.at) / (to.at - from.at);
  return from.value + (to.value - from.value) * progress;
}

/**
 * The exact area under the curve from `from` to `to` (negative when `to` comes first).
 * The renderer uses it to know how far into B a time-stretched stretch has played:
 * ∫ rate dt is B's own seconds.
 */
export function integrate(automation: Automation, from: number, to: number): number {
  if (to < from) return -integrate(automation, to, from);
  // Between consecutive breakpoints the curve is a straight line, so each piece's area is
  // its width times its value halfway along (sampling inside the piece also sidesteps steps).
  const breakpoints = [from, ...automation.map((point) => point.at).filter((at) => at > from && at < to), to];
  let area = 0;
  for (let i = 0; i + 1 < breakpoints.length; i++) {
    const start = breakpoints[i]!;
    const end = breakpoints[i + 1]!;
    if (end > start) area += (end - start) * valueAt(automation, (start + end) / 2);
  }
  return area;
}
