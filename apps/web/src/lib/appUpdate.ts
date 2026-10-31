import { usePlayer } from '../player/store';
import { toast } from './toast';

/** Right after opening, a new version just replaces the old one: nothing is lost yet. */
const JUST_OPENED_MS = 15_000;
const CHECK_EVERY_MS = 30 * 60_000;

/**
 * Show new versions without a second reload. The offline cache opens the version this device already
 * has, while the new one installs in the background; once it has taken over, reload into it if that
 * interrupts nothing (just opened, or in the background, and no music playing), else offer to.
 * Also looks for new versions now and then, and when the app comes back to the foreground.
 */
export function watchForUpdates(openedAt = Date.now()) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  // The first install also takes over the page: that's not an update.
  let hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    const quiet = Date.now() - openedAt < JUST_OPENED_MS || document.visibilityState === 'hidden';
    if (quiet && !usePlayer.getState().playing) window.location.reload();
    else toast('Playarr was updated', 'info', { label: 'Reload', run: () => window.location.reload() });
  });
  const check = () => void sw.getRegistration().then((r) => r?.update()).catch(() => {});
  setInterval(check, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}
