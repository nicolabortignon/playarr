import { normalize } from '../library/search.ts';
import { creditName, releaseGroupRank, type MbArtistCredit, type MbRecordingHit } from '../discover/musicbrainz.ts';
import { titleSimilarity } from './match.ts';
import type { MatchOverlay } from './tags.ts';

/**
 * Identifying one song on its own, for folders no album fits as a whole (a "00s Hits" compilation, a
 * playlist folder): its recording, filed under the most "original" album that recording is on.
 */
export interface SongFacts {
  /** The song's own artist, not the album's ("Coldplay", not "Various Artists"). */
  artist: string;
  title: string;
  duration: number;
}

export interface SongMatch {
  overlay: MatchOverlay;
  score: number;
}

const MIN_TITLE = 0.8;
const MIN_ARTIST = 0.8;
const MAX_LENGTH_DIFF_S = 5;
const VARIOUS_ARTISTS = new Set(['various artists', 'various', 'va']);

export const isVariousArtists = (name: string) => VARIOUS_ARTISTS.has(normalize(name));

/**
 * "Replay (feat. Flo Rida)" → "Replay", "Bad Day (Radio Edit)" → "Bad Day": the guests are in the
 * artist credit, a radio edit is the same song (a remix or a live take isn't), and so is a film's song
 * "(From “Die Another Day”)".
 */
export function bareTitle(title: string): string {
  const bare = title
    .replace(/\s*[([]\s*(feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([]\s*(?:(?:radio|single)\s+(?:edit|mix|version)|edit)\s*[)\]]/gi, '')
    .replace(/\s*[([]\s*from\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '');
  return bare.trim() || title;
}

/** "Flo Rida feat. T-Pain", "Jay-Z & Linkin Park" → the first of them. */
export function leadArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|&|and)\s+|\s*[,;/]\s*/i)[0]!.trim() || artist;
}

function artistSimilarity(artist: string, credit: MbArtistCredit[] | undefined): number {
  if (!credit?.length) return 0;
  const lead = leadArtist(artist);
  return Math.max(
    titleSimilarity(artist, creditName(credit)),
    titleSimilarity(lead, credit[0]!.name),
    titleSimilarity(lead, credit[0]!.artist.name),
  );
}

interface Pick {
  recording: MbRecordingHit;
  release: NonNullable<MbRecordingHit['releases']>[number];
  rank: number;
  date: string;
  score: number;
}

/**
 * The best of a recording search for one file: a recording with the file's title and artist, within 5 s
 * of its length, on an official release that isn't by various artists; of those, the studio album
 * first, then EP, soundtrack, single, compilation and live (releaseGroupRank), the earliest first.
 * Null when no recording fits.
 */
export function songMatch(file: SongFacts, hits: MbRecordingHit[]): SongMatch | null {
  let best: Pick | undefined;
  for (const recording of hits) {
    const title = titleSimilarity(bareTitle(file.title), bareTitle(recording.title));
    const artist = artistSimilarity(file.artist, recording['artist-credit']);
    const length = (recording.length ?? 0) / 1000;
    if (title < MIN_TITLE || artist < MIN_ARTIST) continue;
    if (length > 0 && file.duration > 0 && Math.abs(length - file.duration) > MAX_LENGTH_DIFF_S) continue;
    for (const release of recording.releases ?? []) {
      const rg = release['release-group'];
      if (!rg || (release.status && release.status !== 'Official')) continue;
      // Another various-artists compilation is no better a home than the one the song came from.
      if (isVariousArtists(creditName(release['artist-credit'] ?? recording['artist-credit']))) continue;
      const pick: Pick = {
        recording,
        release,
        rank: releaseGroupRank(rg),
        date: release.date || '9999',
        score: (title + artist) / 2,
      };
      if (!best || pick.rank < best.rank || (pick.rank === best.rank && (pick.date < best.date || (pick.date === best.date && pick.score > best.score)))) {
        best = pick;
      }
    }
  }
  if (!best) return null;
  const { recording, release } = best;
  const rg = release['release-group']!;
  const credit = release['artist-credit'] ?? recording['artist-credit'];
  const medium = release.media?.find((m) => m.track?.length) ?? release.media?.[0];
  const number = Number(medium?.track?.[0]?.number);
  const year = Number(release.date?.slice(0, 4)) || undefined;
  return {
    overlay: {
      recordingMbid: recording.id,
      title: recording.title,
      album: rg.title,
      albumArtist: creditName(credit),
      ...(credit?.[0] ? { albumArtistMbid: credit[0].artist.id } : {}),
      releaseGroupMbid: rg.id,
      ...(medium ? { trackNumber: Number.isInteger(number) && number > 0 ? number : (medium['track-offset'] ?? 0) + 1, discNumber: medium.position ?? 1 } : {}),
      ...(year ? { year } : {}),
    },
    score: Math.round(best.score * 100) / 100,
  };
}
