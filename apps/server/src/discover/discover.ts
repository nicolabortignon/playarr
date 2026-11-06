import type {
  ArtistMatch,
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
import { deezerArtistPicture, deezerArtistTopTracks, searchDeezerTracks, type DeezerTrack } from './deezer.ts';
import { similarArtists } from './listenbrainz.ts';
import { creditName, type MbReleaseGroup, type MusicBrainz } from './musicbrainz.ts';
import type { Requests } from './requests.ts';

const HIDDEN_SECONDARY = new Set(['Live', 'Compilation', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo', 'Interview', 'Spokenword', 'Audiobook', 'Audio drama', 'Field recording']);
/** How many similar artists an artist page shows. */
const SIMILAR_ARTISTS = 24;
const VERSION_WORDS = /\b(remix|mix|live|edit|version|dub|bootleg|cover|instrumental|acoustic|karaoke|tribute)\b/i;

/**
 * Search beyond the library:
 * - artists & albums: Lidarr's metadata search (results carry MusicBrainz ids, ready to request), or MusicBrainz
 *   itself on a server without Lidarr, so search never stops at the library
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

    const lidarr = this.lidarr.configured;
    const [hits, deezer] = await Promise.allSettled([lidarr ? this.lidarr.search(q) : Promise.resolve([]), searchDeezerTracks(q, signal)]);
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
    // "teardrop massive attack": a search for artists finds ones called "Teardrop"; the top song knows better.
    const songArtist = songs.find((s) => nq.includes(normalize(s.artist.name)))?.artist.name;

    if (!lidarr) {
      const found = await this.searchMusicBrainz(q, nq, songArtist, signal);
      if (!found && deezer.status === 'rejected') throw new Error(`Search failed: ${(deezer.reason as Error).message}`);
      const artists = found?.artists ?? [];
      const albums = found?.albums ?? [];
      const knownMbids = new Map([...albums.map((a) => [normalize(a.artistName), a.artistMbid] as const), ...artists.map((a) => [normalize(a.name), a.mbid] as const)]);
      return { artists, albums, tracks: await Promise.all(songs.map((t) => this.deezerTrack(t, knownMbids))) };
    }

    // Artists: Lidarr matches by name, so keep the ones the query actually names.
    let lookupArtists = lidarrHits
      .flatMap((h) => (h.artist ? [h.artist] : []))
      .filter((a) => {
        const name = normalize(a.artistName);
        return name && (nq.includes(name) || name.includes(nq));
      });
    if (songArtist && !lookupArtists.some((a) => normalize(a.artistName) === normalize(songArtist))) {
      const found = await this.lidarr.search(songArtist).catch(() => []);
      const exact = found.find((h) => h.artist && normalize(h.artist.artistName) === normalize(songArtist))?.artist;
      if (exact) lookupArtists = [exact, ...lookupArtists];
    }
    lookupArtists.sort((a, b) => Number(normalize(b.artistName) === nq) - Number(normalize(a.artistName) === nq));

    const albums = rankAlbums(lidarrHits.flatMap((h) => (h.album ? [h.album] : [])), nq, (a) => ({
      title: a.title,
      artist: a.artist.artistName,
      type: a.albumType,
      secondaryTypes: a.secondaryTypes ?? [],
    })).slice(0, 12);

    // Songs only carry artist names; reuse any MusicBrainz ids this search already turned up.
    const knownMbids = new Map<string, string>();
    for (const a of [...lookupArtists, ...lidarrHits.flatMap((h) => [h.artist, h.album?.artist])]) {
      if (a?.foreignArtistId) knownMbids.set(normalize(a.artistName), a.foreignArtistId);
    }

    return {
      artists: await Promise.all(lookupArtists.slice(0, 6).map((a) => this.toArtist(a))),
      albums: await Promise.all(albums.map((a) => this.lookupAlbum(a))),
      tracks: await Promise.all(songs.map((t) => this.deezerTrack(t, knownMbids))),
    };
  }

  /**
   * Artists and albums from MusicBrainz, for a server without Lidarr; undefined when MusicBrainz can't be reached. An
   * artist the query names ("radiohead", "teardrop massive attack") brings their own albums and EPs; any other text
   * finds albums by title.
   */
  private async searchMusicBrainz(
    q: string,
    nq: string,
    songArtist: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ artists: DiscoverArtist[]; albums: DiscoverAlbum[] } | undefined> {
    const found = await this.mb.searchArtists(q, signal).catch(() => undefined);
    let named = (found ?? []).filter((a) => {
      const name = normalize(a.name);
      return name && (nq.includes(name) || name.includes(nq));
    });
    if (songArtist && !named.some((a) => normalize(a.name) === normalize(songArtist))) {
      const more = await this.mb.searchArtists(songArtist, signal).catch(() => []);
      const exact = more.find((a) => normalize(a.name) === normalize(songArtist));
      if (exact) named = [exact, ...named];
    }
    named.sort((a, b) => Number(normalize(b.name) === nq) - Number(normalize(a.name) === nq));

    // The artist whose whole name is in the query: their discography, newest first as on their page, the query's
    // other words picking the album.
    const owner = named.find((a) => nq.includes(normalize(a.name)));
    const groups = await (owner
      ? this.mb.artistReleaseGroups(owner.id, signal).then((rgs) => [...rgs].sort(byNewest))
      : this.mb.searchAlbums(q, signal)
    ).catch(() => undefined);
    if (!found && !groups) return undefined;
    const albums = rankAlbums(groups ?? [], nq, (rg) => ({
      title: rg.title,
      artist: owner?.name ?? creditName(rg['artist-credit']),
      type: rg['primary-type'] ?? '',
      secondaryTypes: rg['secondary-types'] ?? [],
    })).slice(0, 12);

    return {
      artists: await mapLimit(named.slice(0, 6), 3, async (a): Promise<DiscoverArtist> => {
        const artistId = await this.library.artistIdByMbid(a.id);
        const imageUrl = remoteArtUrl(await deezerArtistPicture(a.name, normalize, signal).catch(() => undefined));
        return {
          mbid: a.id,
          name: a.name,
          ...(a.disambiguation ? { disambiguation: a.disambiguation } : {}),
          ...(imageUrl ? { imageUrl } : {}),
          genres: [],
          ...(artistId !== undefined ? { artistId } : {}),
        };
      }),
      albums: await Promise.all(
        albums.map((rg) => {
          const lead = rg['artist-credit']?.[0]?.artist;
          return this.mbAlbum(rg, owner?.name ?? creditName(rg['artist-credit']), owner?.id ?? lead?.id ?? '');
        }),
      ),
    };
  }

  /** Name → MusicBrainz artist, for links from songs that only know a name: library, Lidarr, then MusicBrainz. */
  async findArtist(name: string, signal?: AbortSignal): Promise<ArtistMatch | undefined> {
    const owned = await this.library.artistByName(name);
    if (owned) return { mbid: owned.mbid, artistId: owned.id };
    const want = normalize(name);
    const hits = await this.lidarr.search(name).catch(() => []);
    let mbid = hits.find((h) => h.artist && normalize(h.artist.artistName) === want)?.artist?.foreignArtistId;
    if (!mbid) {
      const found = await this.mb.searchArtists(name, signal).catch(() => []);
      mbid = (found.find((a) => normalize(a.name) === want) ?? found.find((a) => a.score >= 95))?.id;
    }
    return mbid ? { mbid, artistId: await this.library.artistIdByMbid(mbid) } : undefined;
  }

  /**
   * Artists like this one, from ListenBrainz (who real listeners play alongside them), most similar first.
   * Those in the library carry their Playarr id and photo; the others a Deezer photo where it has one.
   */
  async similarArtists(mbid: string, signal?: AbortSignal): Promise<DiscoverArtist[]> {
    const similar = (await similarArtists(mbid, signal)).slice(0, SIMILAR_ARTISTS);
    const owned = new Map((await this.library.artists()).map((a) => [a.id, a]));
    return mapLimit(similar, 4, async (s): Promise<DiscoverArtist> => {
      const artistId = await this.library.artistIdByMbid(s.artist_mbid);
      const mine = artistId !== undefined ? owned.get(artistId) : undefined;
      const imageUrl =
        mine?.imageUrl ?? remoteArtUrl(await deezerArtistPicture(s.name, normalize, signal).catch(() => undefined));
      return {
        mbid: s.artist_mbid,
        name: mine?.name ?? s.name,
        ...(s.comment ? { disambiguation: s.comment } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        genres: mine?.genres.slice(0, 3) ?? [],
        ...(artistId !== undefined ? { artistId } : {}),
      };
    });
  }

  async artist(mbid: string, signal?: AbortSignal): Promise<DiscoverArtistDetail> {
    const [info, groups] = await Promise.allSettled([
      this.lidarr.artistByMbid(mbid),
      this.mb.artistReleaseGroups(mbid, signal),
    ]);
    const lookup = info.status === 'fulfilled' ? info.value : undefined;
    const rgs = groups.status === 'fulfilled' ? groups.value : [];
    if (!lookup && !rgs.length) throw new Error('Artist not found');

    // Without Lidarr, the name MusicBrainz credits this artist with (the first group may be a collaboration).
    const credited = rgs.flatMap((rg) => rg['artist-credit'] ?? []).find((c) => c.artist.id === mbid);
    const name = lookup?.artistName ?? credited?.artist.name ?? creditName(rgs[0]?.['artist-credit']);
    const albums = await Promise.all(
      rgs
        .filter((rg) => ['Album', 'EP'].includes(rg['primary-type'] ?? ''))
        .filter((rg) => !(rg['secondary-types'] ?? []).some((t) => HIDDEN_SECONDARY.has(t)))
        .sort(byNewest)
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

  private async deezerTrack(t: DeezerTrack, knownMbids: Map<string, string>): Promise<DiscoverTrack> {
    const artistMbid = knownMbids.get(normalize(t.artist.name));
    const owned = artistMbid ? undefined : await this.library.artistByName(t.artist.name);
    return {
      id: `deezer:${t.id}`,
      title: t.title,
      artistName: t.artist.name,
      albumTitle: t.album.title,
      duration: t.duration,
      coverUrl: remoteArtUrl(t.album.cover_medium),
      album: { artistName: t.artist.name, albumTitle: t.album.title },
      availability: await this.requests.availabilityByName(t.artist.name, t.album.title),
      artistMbid: artistMbid ?? owned?.mbid,
      artistId: owned?.id ?? (artistMbid ? await this.library.artistIdByMbid(artistMbid) : undefined),
    };
  }
}

/** Release groups, newest first. */
const byNewest = (a: MbReleaseGroup, b: MbReleaseGroup) => (b['first-release-date'] ?? '').localeCompare(a['first-release-date'] ?? '');

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

/** What ranking needs to know of an album hit, from Lidarr or MusicBrainz. */
interface AlbumFacts {
  title: string;
  artist: string;
  type: string;
  secondaryTypes: string[];
}

/** Re-rank album hits: title/artist match and studio albums over singles, remixes, bootlegs. */
export function rankAlbums<T>(albums: T[], nq: string, facts: (album: T) => AlbumFacts): T[] {
  const wantsVersion = VERSION_WORDS.test(nq);
  return albums
    .map((a, i) => {
      const f = facts(a);
      const artist = normalize(f.artist);
      let score = titleScore(nq, normalize(f.title), artist) - i * 0.5;
      if (artist && nq.includes(artist)) score += 30;
      if (f.type === 'Album') score += 10;
      else if (f.type === 'EP') score += 4;
      if (f.secondaryTypes.some((t) => HIDDEN_SECONDARY.has(t))) score -= 10;
      if (!wantsVersion && VERSION_WORDS.test(f.title)) score -= 15;
      if (/various artists/i.test(f.artist)) score -= 12;
      return { a, score };
    })
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
