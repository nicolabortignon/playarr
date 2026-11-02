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
/** The length Crossfade starts with when none was picked yet, so choosing it is heard. */
const FIRST_CROSSFADE: Crossfade = 6;

/** How one song gives way to the next: straight on, a plain fade, or mixed like a DJ when the beats allow. */
export const TRANSITIONS = ['off', 'crossfade', 'dj'] as const;
export type Transitions = (typeof TRANSITIONS)[number];

interface Prefs {
  accent: AccentPref;
  motion: MotionPref;
  formatBadges: boolean;
  /** Count what this device plays towards the mixes (off for a party speaker or a guest's phone). */
  recordPlays: boolean;
  /** When the queue runs out, carry on with songs like the last ones. */
  autoplay: boolean;
  /** How songs follow each other. */
  transitions: Transitions;
  /**
   * Seconds the end of a song and the start of the next overlap, when transitions are 'crossfade'; with
   * DJ mix, how long songs that can't be mixed on the beat fade into each other.
   */
  crossfade: Crossfade;
  /** Turn loud songs down so everything plays at about the same volume. */
  levelVolume: boolean;
  /** Who listens on this device (Settings → Profiles); null until picked. */
  profileId: number | null;
  /** An overlay with everything known about the song playing: tempo, beat grid, sections, loudness, stream. */
  statsForNerds: boolean;
  setAccent(a: AccentPref): void;
  setMotion(m: MotionPref): void;
  setFormatBadges(on: boolean): void;
  setRecordPlays(on: boolean): void;
  setAutoplay(on: boolean): void;
  setTransitions(t: Transitions): void;
  setCrossfade(seconds: Crossfade): void;
  setLevelVolume(on: boolean): void;
  setProfileId(id: number | null): void;
  setStatsForNerds(on: boolean): void;
}

type Saved = Pick<Prefs, 'accent' | 'motion' | 'formatBadges' | 'recordPlays' | 'autoplay' | 'transitions' | 'crossfade' | 'levelVolume' | 'profileId' | 'statsForNerds'>;

export const PREFS_KEY = 'playarr.prefs';
const DEFAULTS: Saved = { accent: 'album', motion: 'system', formatBadges: true, recordPlays: true, autoplay: true, transitions: 'off', crossfade: 0, levelVolume: true, profileId: null, statsForNerds: false };

const isTransitions = (v: unknown): v is Transitions => (TRANSITIONS as readonly unknown[]).includes(v);

const isAccent = (v: unknown): v is AccentPref => v === 'album' || (ACCENTS as readonly unknown[]).includes(v);

/** Whatever was saved, keeping only values this version knows. */
function clean(saved: unknown): Saved {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const crossfade = CROSSFADES.includes(s.crossfade as Crossfade) ? (s.crossfade as Crossfade) : DEFAULTS.crossfade;
  // Saved before transitions existed (or unreadable): whoever had a crossfade keeps fading, everyone else stays gapless.
  const transitions = isTransitions(s.transitions) ? s.transitions : crossfade > 0 ? 'crossfade' : 'off';
  return {
    accent: isAccent(s.accent) ? s.accent : DEFAULTS.accent,
    motion: MOTIONS.includes(s.motion as MotionPref) ? (s.motion as MotionPref) : DEFAULTS.motion,
    formatBadges: typeof s.formatBadges === 'boolean' ? s.formatBadges : DEFAULTS.formatBadges,
    recordPlays: typeof s.recordPlays === 'boolean' ? s.recordPlays : DEFAULTS.recordPlays,
    autoplay: typeof s.autoplay === 'boolean' ? s.autoplay : DEFAULTS.autoplay,
    transitions,
    crossfade: transitions !== 'off' && crossfade === 0 ? FIRST_CROSSFADE : crossfade,
    levelVolume: typeof s.levelVolume === 'boolean' ? s.levelVolume : DEFAULTS.levelVolume,
    profileId: Number.isInteger(s.profileId) && (s.profileId as number) > 0 ? (s.profileId as number) : null,
    statsForNerds: typeof s.statsForNerds === 'boolean' ? s.statsForNerds : DEFAULTS.statsForNerds,
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
      setTransitions: (transitions) =>
        set((s) => {
          if (!isTransitions(transitions)) return { transitions: DEFAULTS.transitions };
          // A fade of 0 seconds would sound like Off: start with a length that is heard.
          return transitions !== 'off' && s.crossfade === 0 ? { transitions, crossfade: FIRST_CROSSFADE } : { transitions };
        }),
      setCrossfade: (crossfade) => set({ crossfade: CROSSFADES.includes(crossfade) ? crossfade : DEFAULTS.crossfade }),
      setLevelVolume: (levelVolume) => set({ levelVolume }),
      setProfileId: (profileId) => set({ profileId }),
      setStatsForNerds: (statsForNerds) => set({ statsForNerds }),
    }),
    {
      name: PREFS_KEY,
      version: 1,
      partialize: ({ accent, motion, formatBadges, recordPlays, autoplay, transitions, crossfade, levelVolume, profileId, statsForNerds }) => ({
        accent,
        motion,
        formatBadges,
        recordPlays,
        autoplay,
        transitions,
        crossfade,
        levelVolume,
        profileId,
        statsForNerds,
      }),
      merge: (saved, current) => ({ ...current, ...clean(saved) }),
    },
  ),
);

/** Seconds songs should overlap on this setting: only Crossfade fades (DJ mix plays gapless until it can mix). */
export const crossfadeSeconds = ({ transitions, crossfade }: Pick<Prefs, 'transitions' | 'crossfade'>): number =>
  transitions === 'crossfade' ? crossfade : 0;

/** With DJ mix, how long songs that can't be mixed on the beat fade into each other. */
export const djFadeSeconds = ({ crossfade }: Pick<Prefs, 'crossfade'>): number => crossfade || FIRST_CROSSFADE;
