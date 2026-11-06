import type { Track } from '@playarr/shared';
import { useEffect, useState } from 'react';
import { sized } from './api';
import { extractAccent, knownAccent, type CoverColors } from './color';
import { setFaviconAccent } from './favicon';
import { ACCENTS, usePrefs } from './prefs';

/** Playarr's own orange (the first of the accent choices): the accent before a cover gives one, as index.css's --accent. */
const DEFAULT_ACCENT = ACCENTS[0];

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
 * the cover where the server hasn't sent one (an older server, a cover not read yet).
 */
export function usePlayerAccent(track: Pick<Track, 'coverUrl' | 'coverAccent' | 'coverColor'> | undefined) {
  const pref = usePrefs((s) => s.accent);
  const { coverUrl, coverAccent, coverColor } = track ?? {};
  useEffect(() => {
    const apply = (color: string) => {
      document.documentElement.style.setProperty('--accent', color);
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
