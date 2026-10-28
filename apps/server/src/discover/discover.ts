import type {
  DiscoverAlbum,
  DiscoverArtist,
  DiscoverArtistDetail,
  DiscoverResults,
  DiscoverTrack,
} from '@playarr/shared';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrImage, LidarrLookupAlbum, LidarrLookupArtist } from '../lidarr/types.ts';
import type { Library } from '../library/library.ts';
import { normalize } from '../library/search.ts';
import { coverArtArchive, remoteArtUrl } from './art.ts';
import { deezerArtistTopTracks, searchDeezerTracks, type DeezerTrack } from './deezer.ts';
import { creditName, type MbReleaseGroup, type MusicBrainz } from './musicbrainz.ts';
import type { Requests } from './requests.ts';

const HIDDEN_SECONDARY = new Set(['Live', 'Compilation', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Interview', 'Spokenword', 'Audiobook', 'Audio drama', 'Field recording']);
const VERSION_WORDS = /\b(remix|mix|live|edit|version|dub|bootleg|cover|instrumental|acoustic|karaoke|tribute)\b/i;

/**
 * Search beyond the library:
 * - artists & albums: Lidarr's metadata search (results carry MusicBrainz ids, ready to request)
 * - songs: Deezer (popularity-ranked); their album is resolved to MusicBrainz when requested
 */
export class Discover {
  constructor(
    private readonly lidarr: LidarrClient,
    private readonly mb: MusicBrainz,
    private readonly library: Library,
    private readonly requests: Requests,
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<DiscoverResults> {
    const q = query.trim();
    if (q.length < 2) return { artists: [], albums: [], tracks: [] };
    const nq = normalize(q);

    const [hits, deezer] = await Promise.allSettled([this.lidarr.search(q), searchDeezerTracks(q, signal)]);
    if (hits.status === 'rejected' && deezer.status === 'rejected') {
      throw new Error(`Search failed: ${(hits.reason as Error).message}`);
    }
    const lidarrHits = hits.status === 'fulfilled' ? hits.value : [];
    let rawTracks = deezer.status === 'fulfilled' ? deezer.value : [];
    // Query names an artist plus a title ("teardrop massive attack"): Deezer's free-text ranking
    // favors remixes containing every word, so also check that artist's most popular tracks.
    const named = rawTracks.find((t) => {
      const a = normalize(t.artist.name);
      return a && a !== nq && nq.includes(a);
    })?.artist;
    if (named) {
      const rest = nq.replace(normalize(named.name), ' ').replace(/\s+/g, ' ').trim();
      const top = await deezerArtistTopTracks(named.id, signal).catch(() => []);
      const matching = top.filter((t) => {
        const title = normalize(t.title_short || t.title);
        return rest && (title.includes(rest) || rest.includes(title));
      });
      rawTracks = [...matching, ...rawTracks];
    }
    const songs = rankTracks(rawTracks, nq).slice(0, 10);

    // Artists: Lidarr matches by name, so keep the ones the query actually names.
    let lookupArtists = lidarrHits
      .flatMap((h) => (h.artist ? [h.artist] : []))
      .filter((a) => {
        const name = normalize(a.artistName);
        return name && (nq.includes(name) || name.includes(nq));
      });
    // "teardrop massive attack": Lidarr finds artists called "Teardrop"; the top song knows better.
    const songArtist = songs.find((s) => nq.includes(normalize(s.artist.name)))?.artist.name;
    if (songArtist && !lookupArtists.some((a) => normalize(a.artistName) === normalize(songArtist))) {
      const found = await this.lidarr.search(songArtist).catch(() => []);
      const exact = found.find((h) => h.artist && normalize(h.artist.artistName) === normalize(songArtist))?.artist;
      if (exact) lookupArtists = [exact, ...lookupArtists];
    }
    lookupArtists.sort((a, b) => Number(normalize(b.artistName) === nq) - Number(normalize(a.artistName) === nq));

    const albums = rankAlbums(lidarrHits.flatMap((h) => (h.album ? [h.album] : [])), nq).slice(0, 12);

    return {
      artists: await Promise.all(lookupArtists.slice(0, 6).map((a) => this.toArtist(a))),
      albums: await Promise.all(albums.map((a) => this.lookupAlbum(a))),
      tracks: await Promise.all(songs.map((t) => this.deezerTrack(t))),
    };
  }

  async artist(mbid: string, signal?: AbortSignal): Promise<DiscoverArtistDetail> {
    const [info, groups] = await Promise.allSettled([
      this.lidarr.artistByMbid(mbid),
      this.mb.artistReleaseGroups(mbid, signal),
    ]);
    const lookup = info.status === 'fulfilled' ? info.value : undefined;
    const rgs = groups.status === 'fulfilled' ? groups.value : [];
    if (!lookup && !rgs.length) throw new Error('Artist not found');

    const name = lookup?.artistName ?? creditName(rgs[0]?.['artist-credit']);
    const albums = await Promise.all(
      rgs
        .filter((rg) => ['Album', 'EP'].includes(rg['primary-type'] ?? ''))
        .filter((rg) => !(rg['secondary-types'] ?? []).some((t) => HIDDEN_SECONDARY.has(t)))
        .sort((a, b) => (b['first-release-date'] ?? '').localeCompare(a['first-release-date'] ?? ''))
        .map((rg) => this.mbAlbum(rg, name, mbid)),
    );
    const base = lookup
      ? await this.toArtist(lookup)
      : { mbid, name, genres: [], artistId: await this.library.artistIdByMbid(mbid) };
    return {
      ...base,
      overview: lookup?.overview || undefined,
      albums,
      discographyError: groups.status === 'rejected' ? (groups.reason as Error).message : undefined,
    };
  }

  private async toArtist(a: LidarrLookupArtist): Promise<DiscoverArtist> {
    return {
      mbid: a.foreignArtistId,
      name: a.artistName,
      disambiguation: a.disambiguation || undefined,
      imageUrl: remoteArtUrl(image(a.images, 'poster') ?? image(a.images, 'fanart')),
      genres: (a.genres ?? []).slice(0, 3),
      artistId: await this.library.artistIdByMbid(a.foreignArtistId),
    };
  }

  private async lookupAlbum(a: LidarrLookupAlbum): Promise<DiscoverAlbum> {
    return {
      mbid: a.foreignAlbumId,
      title: a.title,
      artistName: a.artist.artistName,
      artistMbid: a.artist.foreignArtistId,
      year: yearOf(a.releaseDate),
      type: a.albumType,
      secondaryTypes: a.secondaryTypes ?? [],
      coverUrl: remoteArtUrl(image(a.images, 'cover')) ?? remoteArtUrl(coverArtArchive(a.foreignAlbumId)),
      availability: await this.requests.availability(a.foreignAlbumId),
    };
  }

  private async mbAlbum(rg: MbReleaseGroup, artistName: string, artistMbid: string): Promise<DiscoverAlbum> {
    return {
      mbid: rg.id,
      title: rg.title,
      artistName,
      artistMbid,
      year: yearOf(rg['first-release-date']),
      type: rg['primary-type'] ?? 'Album',
      secondaryTypes: rg['secondary-types'] ?? [],
      coverUrl: remoteArtUrl(coverArtArchive(rg.id)),
      availability: await this.requests.availability(rg.id),
    };
  }

  private async deezerTrack(t: DeezerTrack): Promise<DiscoverTrack> {
    return {
      id: `deezer:${t.id}`,
      title: t.title,
      artistName: t.artist.name,
      albumTitle: t.album.title,
      duration: t.duration,
      coverUrl: remoteArtUrl(t.album.cover_medium),
      album: { artistName: t.artist.name, albumTitle: t.album.title },
      availability: await this.requests.availabilityByName(t.artist.name, t.album.title),
    };
  }
}

function image(images: LidarrImage[], type: string) {
  return images.find((i) => i.coverType === type)?.remoteUrl ?? undefined;
}

function yearOf(date?: string) {
  const y = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN;
  return Number.isFinite(y) && y > 1000 ? y : undefined;
}

/** How well a title matches the (normalized) query, given the artist may also be in the query. */
function titleScore(nq: string, title: string, artist: string): number {
  if (!title) return 0;
  const rest = artist && nq.includes(artist) ? nq.replace(artist, ' ').replace(/\s+/g, ' ').trim() : nq;
  if (title === nq || title === rest) return 40;
  if (rest.includes(title) || nq.includes(title)) return 22;
  if (title.includes(rest)) return 10;
  return 0;
}

/** Re-rank Deezer songs: popularity, then title/artist match; push remixes and live takes down. */
export function rankTracks(tracks: DeezerTrack[], nq: string): DeezerTrack[] {
  const wantsVersion = VERSION_WORDS.test(nq);
  const best = new Map<string, { t: DeezerTrack; score: number }>();
  for (const t of tracks) {
    const title = normalize(t.title_short || t.title);
    const artist = normalize(t.artist.name);
    let score = 10 * Math.log10(t.rank + 10) + titleScore(nq, title, artist);
    if (artist && nq.includes(artist)) score += 30;
    const version = t.title_version ?? '';
    if (!wantsVersion && VERSION_WORDS.test(version)) score -= 18;
    if (!wantsVersion && VERSION_WORDS.test(t.album.title)) score -= 6;
    const key = `${title}|${artist}`;
    const prev = best.get(key);
    if (!prev || score > prev.score) best.set(key, { t, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).map((x) => x.t);
}

/** Re-rank Lidarr's album hits: title/artist match and studio albums over singles, remixes, bootlegs. */
export function rankAlbums(albums: LidarrLookupAlbum[], nq: string): LidarrLookupAlbum[] {
  const wantsVersion = VERSION_WORDS.test(nq);
  return albums
    .map((a, i) => {
      const artist = normalize(a.artist.artistName);
      let score = titleScore(nq, normalize(a.title), artist) - i * 0.5;
      if (artist && nq.includes(artist)) score += 30;
      if (a.albumType === 'Album') score += 10;
      else if (a.albumType === 'EP') score += 4;
      if ((a.secondaryTypes ?? []).some((t) => HIDDEN_SECONDARY.has(t))) score -= 10;
      if (!wantsVersion && VERSION_WORDS.test(a.title)) score -= 15;
      if (/various artists/i.test(a.artist.artistName)) score -= 12;
      return { a, score };
    })
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}
