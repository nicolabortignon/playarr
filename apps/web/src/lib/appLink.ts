/** The iOS app's page on the App Store, by its Apple ID. */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6830169335';

/**
 * Whether pages link to the App Store: not until the app is on sale, since until then the link leads to a page saying
 * it isn't available. Turned on when it goes on sale (docs/ios/release.md, §6).
 */
export const APP_STORE_LIVE = false;

/** An iPhone or iPad, where the Playarr app runs. iPads ask for desktop pages (as a Mac), but have a touch screen. */
export function onIPhoneOrIPad(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

/** A setup code opened in the app (`RedeemLink.swift`): it signs in at `server`, the address this page came from. */
export function appRedeemLink(server: string, code: string): string {
  return `playarr://redeem?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}
