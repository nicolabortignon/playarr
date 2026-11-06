import { usePrefs, type MotionPref } from './prefs';
import { useMediaQuery } from './useMediaQuery';

const REDUCE = '(prefers-reduced-motion: reduce)';

const reduces = (pref: MotionPref, system: boolean) => pref === 'reduce' || (pref === 'system' && system);

/**
 * Whether things should keep still: Settings → Appearance → Motion, or the system's setting while it says System
 * (docs/design.md, Motion). For what moves in JavaScript, or loops in CSS: index.css collapses durations to nothing,
 * which would make a loop flicker, so a loop isn't started at all.
 */
export function useReduceMotion(): boolean {
  const pref = usePrefs((s) => s.motion);
  const system = useMediaQuery(REDUCE);
  return reduces(pref, system);
}

/** `useReduceMotion` at this moment, outside React (an animation about to start). */
export const reduceMotionNow = (): boolean => reduces(usePrefs.getState().motion, typeof matchMedia === 'function' && matchMedia(REDUCE).matches);
