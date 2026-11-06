import { useEffect, useLayoutEffect, useRef } from 'react';
import { useReduceMotion } from '../lib/motion';

type Shape = readonly (readonly [number, number])[];

/**
 * Play, as two halves of its triangle, four corners each (the right half's tip doubled). Drawn a little right of the
 * middle, where a triangle looks centered, as the player's Play always was.
 */
const PLAY: Shape = [
  [7, 3.5],
  [14.5, 7.75],
  [14.5, 16.25],
  [7, 20.5],
  [14.5, 7.75],
  [22, 12],
  [22, 12],
  [14.5, 16.25],
];
/** Pause: lucide's two bars, 5 wide and 18 tall, corner for corner with Play's halves, so each morphs into the other. */
const PAUSE: Shape = [
  [5, 3],
  [10, 3],
  [10, 21],
  [5, 21],
  [14, 3],
  [19, 3],
  [19, 21],
  [14, 21],
];

/** How long Play takes to become Pause, or back: a press answered at once (docs/design.md, Motion). */
export const MORPH_MS = 200;

const round = (n: number) => Math.round(n * 100) / 100;

/** The shape `t` of the way from Play (0) to Pause (1), as a path of its two halves. */
export function playPausePath(t: number): string {
  const at = (i: number) => PLAY[i]!.map((p, axis) => round(p + (PAUSE[i]![axis]! - p) * t)).join(' ');
  const half = (from: number) => `M${at(from)}L${at(from + 1)}L${at(from + 2)}L${at(from + 3)}Z`;
  return half(0) + half(4);
}

const easeOut = (k: number) => 1 - (1 - k) ** 3;

/**
 * Play or Pause, morphing into the other rather than swapping (plan 7 §1): the triangle's halves become the two bars.
 * Filled and stroked as lucide's are (`fill-current`), so it sits with the other icons. Pressed again halfway, it turns
 * back from where it is. At once under Reduce Motion.
 */
export function PlayPauseIcon({ playing, className }: { playing: boolean; className?: string }) {
  const reduce = useReduceMotion();
  const path = useRef<SVGPathElement>(null);
  /** Where the shape is: 0 Play, 1 Pause, between while it morphs. */
  const shown = useRef(playing ? 1 : 0);

  useLayoutEffect(() => {
    path.current?.setAttribute('d', playPausePath(shown.current));
  }, []);

  useEffect(() => {
    const el = path.current;
    const target = playing ? 1 : 0;
    const from = shown.current;
    if (!el || from === target) return;
    const draw = (t: number) => {
      shown.current = t;
      el.setAttribute('d', playPausePath(t));
    };
    if (reduce || typeof requestAnimationFrame !== 'function') return draw(target);
    const start = performance.now();
    const length = MORPH_MS * Math.abs(target - from);
    el.setAttribute('data-morphing', '');
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, Math.max(0, (now - start) / length));
      draw(from + (target - from) * easeOut(k));
      if (k < 1) frame = requestAnimationFrame(step);
      else el.removeAttribute('data-morphing');
    });
    return () => {
      cancelAnimationFrame(frame);
      el.removeAttribute('data-morphing');
    };
  }, [playing, reduce]);

  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden className={className}>
      <path ref={path} data-shape={playing ? 'pause' : 'play'} />
    </svg>
  );
}
