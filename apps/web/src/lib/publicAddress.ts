/**
 * The server's public address (PUBLIC_URL, e.g. https://tracklist.me) when this page is served from another
 * origin, such as http://192.168.1.103:4000 where the owner claims the server at home; null otherwise.
 */
export function elsewhere(publicUrl: string | undefined, here: string = location.origin): URL | null {
  if (!publicUrl || !URL.canParse(publicUrl)) return null;
  const url = new URL(publicUrl);
  return url.origin === here ? null : url;
}

/** Where to sign in once more on the public address: cookies are per origin, so a session here doesn't follow. */
export const signInThere = (publicUrl: string, username: string) => `${publicUrl}/sign-in?username=${encodeURIComponent(username)}`;

/** Leaves for the public address. Replaceable in tests. */
export const publicAddress = {
  go(url: string) {
    location.assign(url);
  },
};
