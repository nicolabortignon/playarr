/** Hosts Playarr will fetch artwork from on the client's behalf (checked on every redirect hop). */
const ALLOWED_HOSTS = [/^images\.lidarr\.audio$/, /^coverartarchive\.org$/, /^(.+\.)?archive\.org$/, /^assets\.fanart\.tv$/, /^(.+\.)?dzcdn\.net$/];

export function isAllowedRemote(url: URL): boolean {
  return url.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(url.hostname));
}

/** Playarr URL that proxies (and resizes/caches) a remote image. */
export function remoteArtUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return isAllowedRemote(new URL(url)) ? `/art/remote?url=${encodeURIComponent(url)}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Front cover for a release group. Goes through Lidarr's image CDN, which serves Cover Art
 * Archive images in one hop instead of CAA's two redirects via archive.org mirrors.
 */
export function coverArtArchive(releaseGroupMbid: string, size: 250 | 500 = 250): string {
  return `https://images.lidarr.audio/cache/https://coverartarchive.org/release-group/${releaseGroupMbid}/front-${size}`;
}

/** Fetch an allowlisted image, following redirects only to allowlisted hosts. */
export async function fetchRemoteImage(url: string): Promise<{ body: Buffer; mime: string } | null> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (!isAllowedRemote(current)) throw new Error(`Host not allowed: ${current.hostname}`);
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Remote art HTTP ${res.status}`);
    const mime = res.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) throw new Error(`Not an image: ${mime}`);
    return { body: Buffer.from(await res.arrayBuffer()), mime };
  }
  throw new Error('Too many redirects');
}
