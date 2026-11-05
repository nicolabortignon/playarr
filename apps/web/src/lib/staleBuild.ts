import { usePlayer } from '../player/store';

/**
 * A lazily loaded file of a build that's been replaced: what the browsers say when the import fails (Chrome,
 * Firefox, Safari). The new service worker takes over open tabs at once, so a tab still on the previous build can
 * ask for a page's file that no longer exists.
 */
const IMPORT_FAILED = /dynamically imported module|Importing a module script failed|not a valid JavaScript MIME type/i;

export const isStaleBuild = (error: unknown): boolean => error instanceof Error && IMPORT_FAILED.test(error.message);

/** Set while a reload for a stale build is under way, so a page that keeps failing doesn't reload for ever. */
const RELOADED = 'playarr:stale-build-reload';

/**
 * Reloads into the new build when that interrupts nothing: online, no music playing, and not already tried in the
 * last moments. True when it reloads; otherwise the page offers a Reload button.
 */
export function reloadIntoNewBuild(): boolean {
  if (sessionStorage.getItem(RELOADED) || usePlayer.getState().playing || !navigator.onLine) return false;
  sessionStorage.setItem(RELOADED, '1');
  window.location.reload();
  return true;
}

/** Once the new build has loaded and run for a while, the next stale build may reload too. */
export function forgetStaleBuildReload(after = 10_000) {
  setTimeout(() => sessionStorage.removeItem(RELOADED), after);
}
