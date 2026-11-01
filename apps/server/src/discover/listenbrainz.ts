/**
 * ListenBrainz "similar recordings" (labs API, no key): recordings that real listeners play in
 * the same sessions as a given recording. https://labs.api.listenbrainz.org
 */

export interface LbSimilarRecording {
  recording_mbid: string;
  recording_name: string;
  artist_credit_name: string;
  release_mbid?: string;
  release_name?: string;
  caa_id?: number;
  caa_release_mbid?: string;
  score: number;
  reference_mbid: string; // the seed recording
}

const ALGORITHM = 'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30';
const TTL_MS = 60 * 60_000;
const cache = new Map<string, { at: number; data: LbSimilarRecording[] }>();
const metadataCache = new Map<string, { at: number; data: LbRecordingMetadata }>();

export async function similarRecordings(recordingMbid: string, signal?: AbortSignal): Promise<LbSimilarRecording[]> {
  const hit = cache.get(recordingMbid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const url = `https://labs.api.listenbrainz.org/similar-recordings/json?recording_mbids=${recordingMbid}&algorithm=${ALGORITHM}`;
  const get = () =>
    fetch(url, {
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
  let res = await get().catch(() => null);
  if (!res || res.status >= 500 || res.status === 429) {
    signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, 1000));
    res = await get();
  }
  if (!res.ok) throw new Error(`ListenBrainz HTTP ${res.status}`);
  const data = (await res.json()) as LbSimilarRecording[];
  cache.set(recordingMbid, { at: Date.now(), data: Array.isArray(data) ? data : [] });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return cache.get(recordingMbid)!.data;
}

export interface LbTag {
  tag: string;
  count: number;
}

export interface LbRecordingMetadata {
  artist?: { name: string; artists?: { artist_mbid: string; name: string; join_phrase: string }[] };
  release?: { mbid: string; name: string; release_group_mbid?: string; album_artist_name?: string; year?: number };
  recording?: { name: string; first_release_date?: string; length?: number };
  tag?: { recording?: LbTag[]; release_group?: LbTag[]; artist?: LbTag[] };
}

/**
 * MusicBrainz ids that the similar-recordings API leaves out (artist mbids, release group),
 * for many recordings in one call. Best effort: an empty map if ListenBrainz is unreachable.
 */
export async function recordingMetadata(mbids: string[], signal?: AbortSignal): Promise<Map<string, LbRecordingMetadata>> {
  const out = new Map<string, LbRecordingMetadata>();
  const wanted = mbids.filter((id) => {
    const hit = metadataCache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) out.set(id, hit.data);
    return !out.has(id);
  });
  if (!wanted.length) return out;
  const url = `https://api.listenbrainz.org/1/metadata/recording/?recording_mbids=${wanted.join(',')}&inc=artist%20release`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as Record<string, LbRecordingMetadata>;
    for (const [id, meta] of Object.entries(data)) {
      out.set(id, meta);
      metadataCache.set(id, { at: Date.now(), data: meta });
    }
    while (metadataCache.size > 5000) metadataCache.delete(metadataCache.keys().next().value!);
  } catch {
    signal?.throwIfAborted();
  }
  return out;
}

/** ListenBrainz said to slow down: try again after `retryIn` seconds. */
export class RateLimited extends Error {
  constructor(readonly retryIn: number) {
    super(`ListenBrainz rate limit: retry in ${retryIn} s`);
  }
}

/**
 * Genre/mood tags and release info for many recordings, with how many more requests ListenBrainz
 * allows before `resetIn` seconds pass. Throws RateLimited when told to wait, else when unreachable.
 */
export async function recordingTags(
  mbids: string[],
  signal?: AbortSignal,
): Promise<{ data: Record<string, LbRecordingMetadata>; remaining?: number; resetIn?: number }> {
  const url = `https://api.listenbrainz.org/1/metadata/recording/?recording_mbids=${mbids.join(',')}&inc=tag%20release`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const header = (name: string) => {
    const v = Number(res.headers.get(name));
    return res.headers.has(name) && Number.isFinite(v) ? v : undefined;
  };
  if (res.status === 429) throw new RateLimited(header('X-RateLimit-Reset-In') ?? 10);
  if (!res.ok) throw new Error(`ListenBrainz HTTP ${res.status}`);
  return {
    data: (await res.json()) as Record<string, LbRecordingMetadata>,
    remaining: header('X-RateLimit-Remaining'),
    resetIn: header('X-RateLimit-Reset-In'),
  };
}

export interface LbSimilarArtist {
  artist_mbid: string;
  name: string;
  comment?: string;
  score: number;
}

const ARTIST_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
const ARTIST_TTL_MS = 6 * 60 * 60_000;
const artistCache = new Map<string, { at: number; data: LbSimilarArtist[] }>();

/** Artists that real listeners play in the same sessions as this one, most similar first. */
export async function similarArtists(artistMbid: string, signal?: AbortSignal): Promise<LbSimilarArtist[]> {
  const hit = artistCache.get(artistMbid);
  if (hit && Date.now() - hit.at < ARTIST_TTL_MS) return hit.data;
  const url = `https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=${artistMbid}&algorithm=${ARTIST_ALGORITHM}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ListenBrainz HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const data = Array.isArray(body) ? (body as LbSimilarArtist[]).filter((a) => a.artist_mbid !== artistMbid) : [];
  artistCache.set(artistMbid, { at: Date.now(), data });
  if (artistCache.size > 500) artistCache.delete(artistCache.keys().next().value!);
  return data;
}
