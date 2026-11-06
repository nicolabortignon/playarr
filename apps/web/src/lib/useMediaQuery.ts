import { useSyncExternalStore } from 'react';

/** Whether a CSS media query matches, following changes (rotating a tablet, resizing a window). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Tailwind's `md` breakpoint: the desktop layout (sidebar, player bar) from here up, the phone layout
 * (bottom tabs, mini player) below. Parts of one layout aren't mounted in the other, so their polling
 * and per-second updates don't run where they can't be seen.
 */
export const useDesktopLayout = () => useMediaQuery('(min-width: 768px)');

/**
 * Tailwind's `xl`: room for the queue and lyrics column beside the page (components/SideColumn.tsx), as on the iPad
 * app. Narrower, the player bar's Queue opens the Queue page and its Lyrics Now Playing's.
 */
export const useColumnLayout = () => useMediaQuery('(min-width: 1280px)');
