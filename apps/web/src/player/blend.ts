import { valueAt, type TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { create } from 'zustand';

/**
 * A DJ blend being heard (plan 7 §2): both songs sounding together, from the start of the transition until the first
 * has faded out. The mini player shows both covers meanwhile, and Now Playing says "Mixing into Teardrop".
 */
export interface Blend {
  from: Track;
  to: Track;
  plan: TransitionPlan;
}

/** Set by the engine (AudioEngine.tsx) as a blend starts and ends: a server's transition, or a live mix on desktop. */
export const useBlend = create<{ blend: Blend | null }>()(() => ({ blend: null }));

/** Only a blend or a quick mix plays both songs at once: a fade or straight on isn't one to show (as endOfSong.ts says). */
export const isBlend = (plan: Pick<TransitionPlan, 'style'>) => plan.style === 'long' || plan.style === 'quick';

/**
 * How long both songs sound together, from the start of the transition: until the song playing has faded out (its
 * gain's last step down to silence), else the plan's beats at its tempo. The rest of the plan is the next song easing
 * back to its own tempo, alone.
 */
export function overlapOf(plan: TransitionPlan, bpmA: number): number {
  const lastHeard = plan.aGain.findLastIndex((p) => p.value > 0);
  if (lastHeard >= 0) return Math.min(plan.aGain[lastHeard + 1]?.at ?? plan.length, plan.length);
  return bpmA > 0 && plan.beats > 0 ? Math.min((plan.beats * 60) / bpmA, plan.length) : plan.length;
}

const share = (automation: TransitionPlan['aGain'], time: number) => (automation.length ? Math.max(0, Math.min(1, valueAt(automation, time))) : 1);

/**
 * How much of each song is in what's heard `time` seconds into the transition, 0–1: each one's gain in the plan, so
 * their covers cross-fade as the songs do.
 */
export function blendShares(plan: TransitionPlan, time: number): { from: number; to: number } {
  return { from: share(plan.aGain, time), to: share(plan.bGain, time) };
}
