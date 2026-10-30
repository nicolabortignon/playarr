import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Settings → Playback and Appearance: personal, kept in this browser only. */

/** Fixed accent colors, besides the one taken from the album art. The first is Playarr's own orange. */
export const ACCENTS = ['#ff7a1a', '#f43f5e', '#a78bfa', '#38bdf8', '#34d399', '#facc15'] as const;

export type AccentPref = 'album' | (typeof ACCENTS)[number];
export type MotionPref = 'system' | 'reduce' | 'full';

const MOTIONS: readonly MotionPref[] = ['system', 'reduce', 'full'];

interface Prefs {
  accent: AccentPref;
  motion: MotionPref;
  formatBadges: boolean;
  setAccent(a: AccentPref): void;
  setMotion(m: MotionPref): void;
  setFormatBadges(on: boolean): void;
}

type Saved = Pick<Prefs, 'accent' | 'motion' | 'formatBadges'>;

export const PREFS_KEY = 'playarr.prefs';
const DEFAULTS: Saved = { accent: 'album', motion: 'system', formatBadges: true };

const isAccent = (v: unknown): v is AccentPref => v === 'album' || (ACCENTS as readonly unknown[]).includes(v);

/** Whatever was saved, keeping only values this version knows. */
function clean(saved: unknown): Saved {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  return {
    accent: isAccent(s.accent) ? s.accent : DEFAULTS.accent,
    motion: MOTIONS.includes(s.motion as MotionPref) ? (s.motion as MotionPref) : DEFAULTS.motion,
    formatBadges: typeof s.formatBadges === 'boolean' ? s.formatBadges : DEFAULTS.formatBadges,
  };
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setAccent: (accent) => set({ accent: isAccent(accent) ? accent : DEFAULTS.accent }),
      setMotion: (motion) => set({ motion: MOTIONS.includes(motion) ? motion : DEFAULTS.motion }),
      setFormatBadges: (formatBadges) => set({ formatBadges }),
    }),
    {
      name: PREFS_KEY,
      version: 1,
      partialize: ({ accent, motion, formatBadges }) => ({ accent, motion, formatBadges }),
      merge: (saved, current) => ({ ...current, ...clean(saved) }),
    },
  ),
);
