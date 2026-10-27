/**
 * Deezer's public search API (no key needed). Used for song search because it ranks by
 * popularity: "bohemian rhapsody" finds Queen, not one of the hundreds of covers.
 * https://developers.deezer.com/api/search
 */

export interface DeezerTrack {
  id: number;
  title: string;
  title_short: string;
  title_version?: string; // e.g. "(Live at Wembley)", "(Remastered 2011)"
  duration: number; // seconds
  rank: number;
  artist: { id: number; name: string; picture_medium?: string };
  album: { id: number; title: string; cover_medium?: string; cover_big?: string };
}

const cache = new Map<string, { at: number; data: DeezerTrack[] }>();
const TTL_MS = 30 * 60_000;

async function get(path: string, signal?: AbortSignal): Promise<DeezerTrack[]> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const res = await fetch(`https://api.deezer.com${path}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Deezer HTTP ${res.status}`);
  const body = (await res.json()) as { data?: DeezerTrack[]; error?: { message: string } };
  if (body.error) throw new Error(`Deezer: ${body.error.message}`);
  const data = body.data ?? [];
  cache.set(path, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return data;
}

export function searchDeezerTracks(query: string, signal?: AbortSignal) {
  return get(`/search/track?q=${encodeURIComponent(query.toLowerCase())}&limit=40`, signal);
}

/** An artist's most popular tracks; finds originals that free-text search buries under remixes. */
export function deezerArtistTopTracks(artistId: number, signal?: AbortSignal) {
  return get(`/artist/${artistId}/top?limit=50`, signal);
}
