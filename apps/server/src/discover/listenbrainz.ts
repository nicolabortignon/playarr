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
