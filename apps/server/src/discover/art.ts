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

/** The most of an image Playarr takes from another server: covers are a few hundred KB, the biggest artist art a few MB. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** An image response's body, refused past `max` bytes: as its length says, or as it arrives when it doesn't say. */
export async function imageBody(res: Response, max = IMAGE_MAX_BYTES): Promise<Buffer> {
  const tooBig = () => new Error(`Image over ${Math.round(max / 1024 / 1024)} MB`);
  if (Number(res.headers.get('content-length')) > max) {
    void res.body?.cancel();
    throw tooBig();
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  // Leaving the loop early cancels the rest of the download.
  for await (const chunk of res.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > max) throw tooBig();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
    return { body: await imageBody(res), mime };
  }
  throw new Error('Too many redirects');
}
