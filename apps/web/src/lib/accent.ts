import type { Track } from '@playarr/shared';
import { useEffect, useRef, useState } from 'react';
import { sized } from './api';
import { extractAccent, knownAccent, type CoverColors } from './color';
import { setFaviconAccent } from './favicon';
import { ACCENTS, usePrefs } from './prefs';

/** Playarr's own orange (the first of the accent choices): the accent before a cover gives one, as index.css's --accent. */
const DEFAULT_ACCENT = ACCENTS[0];

/** How long the accent takes to glide to a new song's color without its tempo (index.css's --accent-glide)… */
export const ACCENT_GLIDE_S = 0.8;
/** …and with it, one beat, kept between these (a misread tempo shouldn't make it snap or crawl). */
const GLIDE_MIN_S = 0.3;
const GLIDE_MAX_S = 1.2;

/** How long the accent glides to a song's color (plan 7 §1): one beat of it when its tempo is known, as a CSS time. */
export function accentGlide(bpm: number | undefined): string {
  const seconds = bpm && bpm > 0 ? Math.min(GLIDE_MAX_S, Math.max(GLIDE_MIN_S, 60 / bpm)) : ACCENT_GLIDE_S;
  return `${Math.round(seconds * 1000)}ms`;
}

/** The accent read from a cover's picture, at the size the accent is read at. */
const readAccent = (coverUrl: string) => extractAccent(sized(coverUrl, 96)!);

/**
 * The accent for a specific cover (an album page's header), apart from what's playing: the server's `coverAccent` at
 * once when it has read the cover, else read here from the picture; null for a cover without one.
 */
export function useCoverAccent(coverUrl: string | undefined, colors?: CoverColors): string | null {
  const known = knownAccent(colors);
  const [read, setRead] = useState<string | null>(null);
  useEffect(() => {
    if (known !== undefined) return;
    if (!coverUrl) return setRead(null);
    let cancelled = false;
    void readAccent(coverUrl).then((c) => !cancelled && setRead(c));
    return () => {
      cancelled = true;
    };
  }, [coverUrl, known]);
  return known !== undefined ? known : read;
}

/**
 * The app's accent and the favicon follow the song playing (docs/design.md, Color), unless Settings → Appearance fixes
 * the color: the song's `coverAccent` at once, so the color changes with the song before its cover has loaded; read from
 * the cover where the server hasn't sent one (an older server, a cover not read yet). It glides there over one beat of
 * the song (`bpm`, its tempo when it's known), else over 0.8 s; at once under Reduce Motion (index.css).
 */
export function usePlayerAccent(track: Pick<Track, 'coverUrl' | 'coverAccent' | 'coverColor'> | undefined, bpm?: number) {
  const pref = usePrefs((s) => s.accent);
  const { coverUrl, coverAccent, coverColor } = track ?? {};
  // Read as the color changes, not a reason to set it again: a tempo learned later doesn't move a glide under way.
  // Set first: effects run in order, so a new song's tempo is there as its color is.
  const glide = useRef(accentGlide(bpm));
  useEffect(() => {
    glide.current = accentGlide(bpm);
  }, [bpm]);
  useEffect(() => {
    const apply = (color: string) => {
      const root = document.documentElement.style;
      // The glide's length first: a transition takes the duration there is as the color changes.
      root.setProperty('--accent-glide', glide.current);
      root.setProperty('--accent', color);
      setFaviconAccent(color);
    };
    if (pref !== 'album') return apply(pref);
    const known = knownAccent({ coverAccent, coverColor });
    if (known !== undefined || !coverUrl) return apply(known ?? DEFAULT_ACCENT);
    let cancelled = false;
    void readAccent(coverUrl).then((color) => !cancelled && apply(color ?? DEFAULT_ACCENT));
    return () => {
      cancelled = true;
    };
  }, [coverUrl, coverAccent, coverColor, pref]);
}
