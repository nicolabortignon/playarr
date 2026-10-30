/**
 * Minimal MusicBrainz client. MusicBrainz allows ~1 request/second per IP and requires a
 * descriptive User-Agent, so requests go through one throttled queue and responses are cached.
 * https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
 */

import type { MbReleaseRaw } from '../catalog/mbRelease.ts';

export interface MbArtistCredit {
  name: string;
  joinphrase?: string;
  artist: { id: string; name: string };
}

export interface MbReleaseGroup {
  id: string;
  title: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'first-release-date'?: string;
  'artist-credit'?: MbArtistCredit[];
}

export interface MbReleaseHit {
  id: string;
  score: number;
  title: string;
  'track-count': number;
  date?: string;
  'release-group'?: { id: string; 'primary-type'?: string; 'secondary-types'?: string[] | null };
  'artist-credit'?: MbArtistCredit[];
}

const BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 30 * 60_000;

export class MusicBrainz {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  private cache = new Map<string, { at: number; data: unknown }>();
  private waiting = 0;
  private waitingBackground = 0;

  constructor(private readonly userAgent: string) {}

  /** How long the line is, so the UI can explain a slow lookup. */
  status(): { queued: number; background: number; etaSeconds: number } {
    return {
      queued: this.waiting,
      background: this.waitingBackground,
      etaSeconds: Math.ceil((this.waiting * MIN_INTERVAL_MS) / 1000),
    };
  }

  /** `background`: work nobody is waiting on (matching folder music), counted separately in `status()`. */
  async get<T>(path: string, signal?: AbortSignal, opts: { background?: boolean } = {}): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;
    this.waiting++;
    if (opts.background) this.waitingBackground++;

    const run = async (): Promise<T> => {
      // A newer search may have superseded this one while it waited in line.
      signal?.throwIfAborted();
      const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      signal?.throwIfAborted();
      this.lastRequest = Date.now();

      // One retry on rate limiting (503) or a network hiccup, after a short back-off.
      let res = await this.fetch(path).catch(() => null);
      if (!res || res.status === 503) {
        signal?.throwIfAborted();
        await new Promise((r) => setTimeout(r, 2000));
        this.lastRequest = Date.now();
        res = await this.fetch(path);
      }
      if (!res.ok) throw new Error(`MusicBrainz ${res.status} for ${path.split('?')[0]}`);
      const data = (await res.json()) as T;
      this.cache.set(path, { at: Date.now(), data });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
      return data;
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result.finally(() => {
      this.waiting--;
      if (opts.background) this.waitingBackground--;
    });
  }

  private fetch(path: string) {
    return fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** Find a release group by artist + album title (fallback when Lidarr's lookup can't). */
  searchReleaseGroups(artistName: string, albumTitle: string, signal?: AbortSignal) {
    const query = `releasegroup:"${luceneEscape(albumTitle)}" AND artist:"${luceneEscape(artistName)}"`;
    return this.get<{ 'release-groups': MbReleaseGroup[] }>(
      `/release-group?query=${encodeURIComponent(query)}&limit=10`,
      signal,
    ).then((r) => r['release-groups']);
  }

  /** Artists by name, best match first. */
  searchArtists(name: string, signal?: AbortSignal) {
    return this.get<{ artists: { id: string; name: string; score: number }[] }>(
      `/artist?query=${encodeURIComponent(`artist:"${luceneEscape(name)}"`)}&limit=5`,
      signal,
    ).then((r) => r.artists);
  }

  /** The release group (album) a specific release (edition) belongs to. */
  releaseGroupOf(releaseMbid: string, signal?: AbortSignal) {
    return this.get<{ 'release-group'?: MbReleaseGroup }>(
      `/release/${encodeURIComponent(releaseMbid)}?inc=release-groups`,
      signal,
    ).then((r) => r['release-group']);
  }

  /** An artist's albums and EPs (singles would drown them out). Browse returns up to 100 per page. */
  artistReleaseGroups(artistMbid: string, signal?: AbortSignal) {
    return this.get<{ 'release-groups': MbReleaseGroup[] }>(
      `/release-group?artist=${encodeURIComponent(artistMbid)}&type=album|ep&limit=100`,
      signal,
    ).then((r) => r['release-groups']);
  }

  /** Releases (editions) by album title and artist, best match first. */
  searchReleases(artistName: string, albumTitle: string, signal?: AbortSignal, opts?: { background?: boolean }) {
    const query = `release:"${luceneEscape(albumTitle)}" AND artist:"${luceneEscape(artistName)}"`;
    return this.get<{ releases: MbReleaseHit[] }>(`/release?query=${encodeURIComponent(query)}&limit=10`, signal, opts).then(
      (r) => r.releases,
    );
  }

  /** One release with its track list. */
  release(releaseMbid: string, signal?: AbortSignal, opts?: { background?: boolean }) {
    return this.get<MbReleaseRaw>(
      `/release/${encodeURIComponent(releaseMbid)}?inc=recordings+artist-credits+release-groups+labels`,
      signal,
      opts,
    );
  }
}

/** Escape Lucene query syntax so user input is matched literally. */
export function luceneEscape(s: string): string {
  return s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1').trim();
}

export function creditName(credit?: MbArtistCredit[]): string {
  return credit?.map((c) => c.name + (c.joinphrase ?? '')).join('') ?? 'Unknown artist';
}

/** Lower is better: studio album first, then EP, soundtrack, single, compilation, live. */
export function releaseGroupRank(rg: MbReleaseGroup): number {
  const type = rg['primary-type'];
  const secondary = rg['secondary-types'] ?? [];
  if (type === 'Album' && secondary.length === 0) return 0;
  if (type === 'EP' && secondary.length === 0) return 1;
  if (secondary.includes('Soundtrack')) return 2;
  if (type === 'Single') return 3;
  if (secondary.includes('Compilation')) return 4;
  if (secondary.includes('Live')) return 6;
  return 5;
}
