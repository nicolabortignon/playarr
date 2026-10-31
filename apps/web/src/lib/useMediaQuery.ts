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
