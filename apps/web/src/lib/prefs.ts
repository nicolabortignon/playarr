import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Settings → Playback and Appearance: personal, kept in this browser only. */

/** Fixed accent colors, besides the one taken from the album art. The first is Playarr's own orange. */
export const ACCENTS = ['#ff7a1a', '#f43f5e', '#a78bfa', '#38bdf8', '#34d399', '#facc15'] as const;

export type AccentPref = 'album' | (typeof ACCENTS)[number];
export type MotionPref = 'system' | 'reduce' | 'full';

const MOTIONS: readonly MotionPref[] = ['system', 'reduce', 'full'];
/** Crossfade lengths offered, in seconds (0: none, songs follow each other without a gap). */
export const CROSSFADES = [0, 3, 6, 9, 12] as const;
export type Crossfade = (typeof CROSSFADES)[number];

interface Prefs {
  accent: AccentPref;
  motion: MotionPref;
  formatBadges: boolean;
  /** Count what this device plays towards the mixes (off for a party speaker or a guest's phone). */
  recordPlays: boolean;
  /** When the queue runs out, carry on with songs like the last ones. */
  autoplay: boolean;
  /** Seconds the end of a song and the start of the next overlap. */
  crossfade: Crossfade;
  /** Turn loud songs down so everything plays at about the same volume. */
  levelVolume: boolean;
  setAccent(a: AccentPref): void;
  setMotion(m: MotionPref): void;
  setFormatBadges(on: boolean): void;
  setRecordPlays(on: boolean): void;
  setAutoplay(on: boolean): void;
  setCrossfade(seconds: Crossfade): void;
  setLevelVolume(on: boolean): void;
}

type Saved = Pick<Prefs, 'accent' | 'motion' | 'formatBadges' | 'recordPlays' | 'autoplay' | 'crossfade' | 'levelVolume'>;

export const PREFS_KEY = 'playarr.prefs';
const DEFAULTS: Saved = { accent: 'album', motion: 'system', formatBadges: true, recordPlays: true, autoplay: true, crossfade: 0, levelVolume: true };

const isAccent = (v: unknown): v is AccentPref => v === 'album' || (ACCENTS as readonly unknown[]).includes(v);

/** Whatever was saved, keeping only values this version knows. */
function clean(saved: unknown): Saved {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  return {
    accent: isAccent(s.accent) ? s.accent : DEFAULTS.accent,
    motion: MOTIONS.includes(s.motion as MotionPref) ? (s.motion as MotionPref) : DEFAULTS.motion,
    formatBadges: typeof s.formatBadges === 'boolean' ? s.formatBadges : DEFAULTS.formatBadges,
    recordPlays: typeof s.recordPlays === 'boolean' ? s.recordPlays : DEFAULTS.recordPlays,
    autoplay: typeof s.autoplay === 'boolean' ? s.autoplay : DEFAULTS.autoplay,
    crossfade: CROSSFADES.includes(s.crossfade as Crossfade) ? (s.crossfade as Crossfade) : DEFAULTS.crossfade,
    levelVolume: typeof s.levelVolume === 'boolean' ? s.levelVolume : DEFAULTS.levelVolume,
  };
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setAccent: (accent) => set({ accent: isAccent(accent) ? accent : DEFAULTS.accent }),
      setMotion: (motion) => set({ motion: MOTIONS.includes(motion) ? motion : DEFAULTS.motion }),
      setFormatBadges: (formatBadges) => set({ formatBadges }),
      setRecordPlays: (recordPlays) => set({ recordPlays }),
      setAutoplay: (autoplay) => set({ autoplay }),
      setCrossfade: (crossfade) => set({ crossfade: CROSSFADES.includes(crossfade) ? crossfade : DEFAULTS.crossfade }),
      setLevelVolume: (levelVolume) => set({ levelVolume }),
    }),
    {
      name: PREFS_KEY,
      version: 1,
      partialize: ({ accent, motion, formatBadges, recordPlays, autoplay, crossfade, levelVolume }) => ({
        accent,
        motion,
        formatBadges,
        recordPlays,
        autoplay,
        crossfade,
        levelVolume,
      }),
      merge: (saved, current) => ({ ...current, ...clean(saved) }),
    },
  ),
);
