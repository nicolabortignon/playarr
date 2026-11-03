import type { ReviewCandidate, ReviewGroup } from '@playarr/shared';
import { posix } from 'node:path';
import type { MbRecordingHit, MbReleaseHit } from '../discover/musicbrainz.ts';
import { coverArtArchive, remoteArtUrl } from '../discover/art.ts';
import { normalize } from '../library/search.ts';
import type { AcoustIdMatch, Fingerprint } from './acoustid.ts';
import { describeFile } from './folder.ts';
import { scoreRelease, verdict, type FileFacts, type ReleaseScore } from './match.ts';
import { formatSummary, type MbReleaseInfo } from './mbRelease.ts';
import { bareTitle, isVariousArtists, leadArtist, songMatch, WIDE_LENGTH_S, type SongMatch } from './songMatch.ts';
import type { CatalogStore } from './store.ts';
import type { MatchOverlay, MatchRecord, TagInfo } from './tags.ts';

export interface GroupFile extends FileFacts {
  /** The song's own artist ("Coldplay" on a "Various Artists" compilation). */
  artist: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FileGroup {
  key: string;
  artistName: string;
  albumTitle?: string;
  files: GroupFile[];
  /** One song of a compilation, matched and reviewed on its own (see groupFiles). */
  compilation?: true;
}

export interface MatcherDeps {
  store: CatalogStore;
  mb: {
    searchReleases(artist: string, album: string): Promise<MbReleaseHit[]>;
    release(id: string): Promise<MbReleaseInfo>;
    /** For files that call the artist by another name MusicBrainz knows them by ("N Sync" for *NSYNC). */
    searchArtists?(name: string): Promise<{ id: string; score: number }[]>;
    searchReleasesOfArtist?(artistMbid: string, album: string): Promise<MbReleaseHit[]>;
    /** Recordings of one song near that length, for folders no album fits (see bySong). */
    searchRecordings?(artist: string, title: string, seconds: number): Promise<MbRecordingHit[]>;
  };
  acoustid?: { enabled: boolean; lookup(fp: Fingerprint): Promise<AcoustIdMatch | null> };
  /** A file's fingerprint, computed where the source's files are; null where it can't be. */
  fingerprint?: (sourceId: number, path: string) => Promise<Fingerprint | null>;
  /** Matches changed: rebuild the library (debounced by the caller). */
  onMatched: () => void;
  log: { warn: (msg: string) => void };
}

const SEARCH_MIN_SCORE = 70;
const CANDIDATES = 3;
const FINGERPRINT_MIN_SCORE = 0.8;
/** releaseGroupRank up to here is a song's own album: studio album, EP, soundtrack (not a single or compilation). */
const ALBUM_RANK = 2;

/**
 * Files by album (album tag, else folder). Skips files already identified by their tags. A compilation
 * (songs by many artists under one album name) is split into its songs, each a group of its own under its
 * artist: each is matched, and reviewed, apart from the others.
 */
export function groupFiles(
  root: string,
  files: { rel: string; size: number; mtimeMs: number; tags: TagInfo | null }[],
  matches: Map<string, MatchRecord>,
  include: (rel: string, size: number, mtimeMs: number, match?: MatchRecord) => boolean = (rel, size, mtimeMs, match) =>
    !match || (match.state !== 'manual' && match.state !== 'ignored' && (match.size !== size || match.mtimeMs !== mtimeMs)),
): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    if (!f.tags || (f.tags.recordingMbid && f.tags.releaseGroupMbid)) continue;
    if (!include(f.rel, f.size, f.mtimeMs, matches.get(f.rel))) continue;
    const d = describeFile(f.rel, f.tags);
    const key = d.albumTitle
      ? `${normalize(d.artistName)}|${normalize(d.albumTitle)}`
      : `dir:${f.rel.split('/').slice(0, -1).join('/')}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, artistName: d.artistName, albumTitle: d.albumTitle, files: [] }));
    group.files.push({ rel: f.rel, artist: f.tags.artist || d.artistName, path: posix.join(root, f.rel), size: f.size, mtimeMs: f.mtimeMs, ...pick(d) });
  }
  return [...groups.values()].flatMap((g) =>
    isCompilation(g)
      ? g.files.map((f) => ({ key: `${g.key}|${f.rel}`, artistName: f.artist, albumTitle: g.albumTitle, files: [f], compilation: true as const }))
      : [g],
  );
}

const pick = (d: ReturnType<typeof describeFile>): Omit<FileFacts, 'rel'> => ({
  title: d.title,
  trackNumber: d.trackNumber,
  discNumber: d.discNumber,
  duration: d.duration,
});

/** Identifies folder music on MusicBrainz in the background, one album group at a time. */
export class Matcher {
  private readonly queue = new Set<number>();
  private running = false;
  private readonly pending = new Map<number, number>();

  constructor(private readonly deps: MatcherDeps) {}

  /** Match whatever is new in this source (after a scan). */
  enqueue(sourceId: number) {
    this.queue.add(sourceId);
    void this.run();
  }

  /** Album groups still waiting to be matched. */
  pendingGroups(sourceId: number): number {
    return this.pending.get(sourceId) ?? 0;
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size) {
        const id = this.queue.values().next().value!;
        this.queue.delete(id);
        await this.matchSource(id);
      }
    } finally {
      this.running = false;
    }
  }

  async matchSource(sourceId: number) {
    const groups = this.groups(sourceId);
    this.pending.set(sourceId, groups.length);
    let unsaved = 0;
    for (const group of groups) {
      try {
        this.deps.store.saveMatches(sourceId, await this.matchGroup(sourceId, group));
        unsaved++;
      } catch (err) {
        // Left without a row: tried again after the next scan.
        this.deps.log.warn(`Matching “${group.albumTitle ?? group.key}” failed: ${(err as Error).message}`);
      }
      this.pending.set(sourceId, Math.max(0, this.pendingGroups(sourceId) - 1));
      if (unsaved >= 10) {
        this.deps.onMatched();
        unsaved = 0;
      }
    }
    if (unsaved) this.deps.onMatched();
  }

  /** Use this release for a group (from the review list). */
  async applyRelease(sourceId: number, groupKey: string, releaseId: string) {
    const group = this.groupByKey(sourceId, groupKey);
    if (!group) throw new Error('That album isn’t waiting for review any more');
    const scored = scoreRelease(group.files, await this.release(releaseId));
    this.deps.store.saveMatches(sourceId, this.fromAlignment(group, scored, 'manual'));
    this.deps.onMatched();
  }

  /**
   * Match a file's album group again from scratch (Show metadata → Match again): forget what was decided
   * for it, the user's own choices included, and run the match now. Says what became of that file.
   */
  async rematchFile(sourceId: number, rel: string): Promise<MatchRecord['state']> {
    const root = (this.deps.store.source(sourceId)?.settings as { path?: string } | undefined)?.path;
    if (!root) throw new Error('That folder source is gone');
    const groupOf = () =>
      groupFiles(root, this.files(sourceId), this.deps.store.matches(sourceId), () => true).find((g) => g.files.some((f) => f.rel === rel));
    const before = groupOf();
    if (!before) throw new Error('That file isn’t in its folder any more');
    this.deps.store.forgetMatches(sourceId, before.files.map((f) => f.rel));
    // Regroup from the files' own tags, now that the old match no longer shapes the group.
    const group = groupOf();
    if (!group) throw new Error('That file isn’t in its folder any more');
    const records = await this.matchGroup(sourceId, group);
    this.deps.store.saveMatches(sourceId, records);
    this.deps.onMatched();
    return records.find((r) => r.rel === rel)?.state ?? 'unmatched';
  }

  /**
   * Use the names the user gave (artist, album, song titles) instead of the files' own, without a
   * MusicBrainz match; the group leaves the review list and isn't matched again.
   */
  rename(sourceId: number, groupKey: string, names: { artist: string; album: string; titles: Record<string, string> }) {
    const group = this.groupByKey(sourceId, groupKey);
    if (!group) throw new Error('That album isn’t waiting for review any more');
    this.deps.store.saveMatches(
      sourceId,
      this.waiting(sourceId, group).map((f) => ({
        ...this.record(group, f, 'manual'),
        overlay: { albumArtist: names.artist, album: names.album, title: names.titles[f.rel]?.trim() || f.title },
      })),
    );
    this.deps.onMatched();
  }

  /** Leave a group as its tags and names describe it, and never match it again. */
  ignore(sourceId: number, groupKey: string) {
    const group = this.groupByKey(sourceId, groupKey);
    if (!group) return;
    this.deps.store.saveMatches(sourceId, this.waiting(sourceId, group).map((f) => this.record(group, f, 'ignored')));
    this.deps.onMatched();
  }

  /** Search MusicBrainz again with other names; the group's candidates are replaced. */
  async search(sourceId: number, groupKey: string, artist: string, album: string) {
    const group = this.groupByKey(sourceId, groupKey);
    if (!group) throw new Error('That album isn’t waiting for review any more');
    const scored = await this.candidates(group, artist, album);
    const ids = scored.slice(0, CANDIDATES).map((s) => s.release.id);
    this.deps.store.saveMatches(
      sourceId,
      group.files.map((f) => ({ ...this.record(group, f, 'review'), candidates: ids, score: scored[0]?.score })),
    );
  }

  /**
   * Fetch the edition details (labels, country, formats…) of the candidates the review list is about to
   * show, for releases cached before those were fetched. Only the first `groups` groups: the dialog shows
   * one at a time, and each release is fetched once.
   */
  async refreshReviewDetails(sourceId: number, groups = 1): Promise<void> {
    const review = [...this.deps.store.matches(sourceId).values()].filter((m) => m.state === 'review');
    const keys = [...new Set(review.map((m) => m.groupKey))].slice(0, groups);
    const ids = new Set(keys.flatMap((key) => review.find((m) => m.groupKey === key)?.candidates ?? []));
    for (const id of ids) {
      if (this.deps.store.cachedRelease(id)?.detailed) continue;
      try {
        this.deps.store.saveRelease(await this.deps.mb.release(id));
      } catch (err) {
        // The list still works with what's cached.
        this.deps.log.warn(`MusicBrainz release ${id}: ${(err as Error).message}`);
      }
    }
  }

  private readonly refreshing = new Map<number, Promise<void>>();

  /**
   * refreshReviewDetails in the background, once at a time per source, for the album on screen and the
   * next one (so it's ready when the user moves on). The review list answers at once from the cache and
   * marks candidates still waiting for details.
   */
  refreshReviewDetailsSoon(sourceId: number, groups = 2): void {
    if (this.refreshing.has(sourceId)) return;
    const run = this.refreshReviewDetails(sourceId, groups).finally(() => this.refreshing.delete(sourceId));
    this.refreshing.set(sourceId, run);
  }

  reviewGroups(sourceId: number): ReviewGroup[] {
    const matches = this.deps.store.matches(sourceId);
    // The folder as it groups now (once, not once per album: a folder of loose songs has hundreds), not
    // as it grouped when matched, so files matched under an older grouping are still listed.
    const waiting = this.allGroups(sourceId, matches).flatMap((group) => {
      const records = group.files.map((f) => matches.get(f.rel));
      const review = records.find((m) => m?.state === 'review');
      const notFound = records.some((m) => m?.state === 'unmatched');
      return review || notFound ? [{ group, ids: review?.candidates ?? [], notFound }] : [];
    });
    // Albums with candidates to choose from first, then those nothing was found for.
    waiting.sort((a, b) => Number(!a.ids.length) - Number(!b.ids.length));
    return waiting.map(({ group, ids, notFound }) => {
      const candidates = ids.flatMap((id) => {
        const release = this.deps.store.cachedRelease(id);
        return release ? [toCandidate(scoreRelease(group.files, release))] : [];
      });
      return {
        groupKey: group.key,
        artistName: group.artistName,
        albumTitle: group.albumTitle,
        files: waitingIn(group, matches).map(({ rel, title, trackNumber, discNumber, duration }) => ({ rel, title, trackNumber, discNumber, duration })),
        candidates,
        ...(!candidates.length && notFound ? { notFound: true as const } : {}),
      };
    });
  }

  private groups(sourceId: number): FileGroup[] {
    const root = (this.deps.store.source(sourceId)?.settings as { path?: string } | undefined)?.path;
    if (!root) return [];
    return groupFiles(root, this.files(sourceId), this.deps.store.matches(sourceId));
  }

  /** A group with all its files, whatever their state. */
  private groupByKey(sourceId: number, groupKey: string): FileGroup | undefined {
    return this.allGroups(sourceId).find((g) => g.key === groupKey);
  }

  /** Every group with all its files, whatever their state. */
  private allGroups(sourceId: number, matches = this.deps.store.matches(sourceId)): FileGroup[] {
    const root = (this.deps.store.source(sourceId)?.settings as { path?: string } | undefined)?.path;
    if (!root) return [];
    return groupFiles(root, this.files(sourceId), matches, () => true);
  }

  private waiting(sourceId: number, group: FileGroup): GroupFile[] {
    return waitingIn(group, this.deps.store.matches(sourceId));
  }

  private files(sourceId: number) {
    return [...this.deps.store.folderFiles(sourceId)].map(([rel, f]) => ({ rel, ...f }));
  }

  private async matchGroup(sourceId: number, group: FileGroup): Promise<MatchRecord[]> {
    // A compilation's song is never matched to an album by the compilation's name.
    const scored = group.albumTitle && !group.compilation ? await this.candidates(group, group.artistName, group.albumTitle) : [];
    const best = scored[0];
    const outcome = verdict(best);
    if (outcome === 'auto') return this.fromAlignment(group, best!, 'auto');
    // Songs by many artists no release fits: each song on its own, by its name, then by its sound.
    const compilation = isCompilation(group);
    if (compilation) {
      const bySong = await this.bySong(sourceId, group, true);
      if (bySong) return bySong;
    }
    const byFingerprint = compilation ? null : await this.byFingerprint(sourceId, group);
    if (byFingerprint) return byFingerprint;
    // An album MusicBrainz doesn't know: its songs may still be on others.
    if (!compilation && outcome === 'unmatched') {
      const bySong = await this.bySong(sourceId, group, false);
      if (bySong) return bySong;
    }
    if (outcome === 'review') {
      const ids = scored.slice(0, CANDIDATES).map((s) => s.release.id);
      return group.files.map((f) => ({ ...this.record(group, f, 'review'), candidates: ids, score: best!.score }));
    }
    return group.files.map((f) => this.record(group, f, 'unmatched'));
  }

  private async candidates(group: FileGroup, artist: string, album: string): Promise<ReleaseScore[]> {
    const { mb } = this.deps;
    let hits = (await mb.searchReleases(artist, album)).filter((h) => h.score >= SEARCH_MIN_SCORE).slice(0, CANDIDATES);
    // Nothing under that artist name: it may be another name they go by. Find the artist, then the album.
    if (!hits.length && mb.searchArtists && mb.searchReleasesOfArtist) {
      const found = (await mb.searchArtists(artist)).find((a) => a.score >= 90);
      if (found) {
        hits = (await mb.searchReleasesOfArtist(found.id, album)).filter((h) => h.score >= SEARCH_MIN_SCORE).slice(0, CANDIDATES);
      }
    }
    const scored: ReleaseScore[] = [];
    for (const h of hits) scored.push(scoreRelease(group.files, await this.release(h.id)));
    return scored.sort((a, b) => b.score - a.score);
  }

  private async release(id: string): Promise<MbReleaseInfo> {
    const cached = this.deps.store.cachedRelease(id);
    if (cached) return cached;
    const release = await this.deps.mb.release(id);
    this.deps.store.saveRelease(release);
    return release;
  }

  private async byFingerprint(sourceId: number, group: FileGroup): Promise<MatchRecord[] | null> {
    const { acoustid, fingerprint } = this.deps;
    if (!acoustid?.enabled || !fingerprint) return null;
    const records: MatchRecord[] = [];
    let found = 0;
    for (const f of group.files) {
      const m = await this.fingerprintMatch(sourceId, f, false);
      if (!m) {
        records.push(this.record(group, f, 'unmatched'));
        continue;
      }
      found++;
      records.push({ ...this.record(group, f, 'auto'), overlay: m.overlay, score: m.score });
    }
    // Mostly unknown to AcoustID: keep the group as names left it.
    return found * 2 >= group.files.length ? records : null;
  }

  /**
   * One file by its sound (AcoustID), filed under the most original album its recording is on. A
   * compilation's song skips compilations: one of those is no better than the one it came from.
   */
  private async fingerprintMatch(sourceId: number, f: GroupFile, offCompilation: boolean): Promise<SongMatch | null> {
    const { acoustid, fingerprint } = this.deps;
    if (!acoustid?.enabled || !fingerprint) return null;
    const fp = await fingerprint(sourceId, f.path);
    const m = fp && (await acoustid.lookup(fp));
    if (!m || m.score < FINGERPRINT_MIN_SCORE) return null;
    // Nor albums by various artists, typed as compilations or not ("Jule CD'n 2000" is a plain album).
    const groups = offCompilation
      ? m.releaseGroups.filter((g) => !g.secondaryTypes.includes('Compilation') && !isVariousArtists(g.artistName ?? ''))
      : m.releaseGroups;
    const rg = originalReleaseGroup(groups);
    if (!rg) return null;
    return {
      overlay: { recordingMbid: m.recordingId, title: m.title, albumArtist: m.artistName, albumArtistMbid: m.artistId, releaseGroupMbid: rg.id, album: rg.title },
      score: m.score,
      rank: 0,
    };
  }

  /**
   * Each song on its own: its recording found by artist, title and length, filed under the most original
   * album it's on (songMatch), as just that song rather than the album's whole track list. A compilation
   * keeps every song found; other folders only when most were, since the rest is likely an album
   * MusicBrainz lacks, better reviewed whole than scattered.
   */
  private async bySong(sourceId: number, group: FileGroup, compilation: boolean): Promise<MatchRecord[] | null> {
    if (!this.deps.mb.searchRecordings) return null;
    const records: MatchRecord[] = [];
    let found = 0;
    let failed: unknown;
    for (const f of group.files) {
      let m: SongMatch | null;
      try {
        m = await this.songOf(sourceId, f, compilation);
      } catch (err) {
        // Left without a row, so tried again after the next scan, while the songs found keep their match.
        failed = err;
        continue;
      }
      if (!m) {
        records.push(this.record(group, f, 'unmatched'));
        continue;
      }
      found++;
      records.push({ ...this.record(group, f, 'auto'), overlay: m.overlay, score: m.score });
    }
    if (!found && failed) throw failed;
    return found && (compilation || found * 2 >= records.length) ? records : null;
  }

  /**
   * One song's album: its recording within 5 s of the file's length, on a studio album, EP or soundtrack;
   * else any version up to 90 s off on a better one (a radio edit found only on its single still belongs
   * to its album: Madonna's 4 Minutes to Hard Candy); else the close one; else, for a compilation's
   * song, by its sound.
   */
  private async songOf(sourceId: number, f: GroupFile, compilation: boolean): Promise<SongMatch | null> {
    const search = this.deps.mb.searchRecordings!;
    const title = bareTitle(f.title);
    const close = songMatch(f, await search(f.artist, title, f.duration));
    if (close && close.rank <= ALBUM_RANK) return close;
    const wide = f.duration > 0 ? songMatch(f, await search(f.artist, title, 0), WIDE_LENGTH_S) : null;
    const best = wide && (!close || wide.rank < close.rank) ? wide : close;
    if (best) return best;
    return compilation ? this.fingerprintMatch(sourceId, f, true) : null;
  }

  private fromAlignment(group: FileGroup, scored: ReleaseScore, state: 'auto' | 'manual'): MatchRecord[] {
    const { release } = scored;
    const year = Number(release.releaseGroup.firstReleaseDate?.slice(0, 4)) || undefined;
    const byRel = new Map(scored.alignment.map((a) => [a.rel, a]));
    return group.files.map((f) => {
      const a = byRel.get(f.rel);
      if (!a) return this.record(group, f, state === 'manual' ? 'ignored' : 'unmatched');
      const overlay: MatchOverlay = {
        recordingMbid: a.track.recordingId,
        title: a.track.title,
        trackNumber: a.track.position,
        discNumber: a.track.disc,
        album: release.releaseGroup.title,
        albumArtist: release.artistName,
        albumArtistMbid: release.artistId,
        releaseGroupMbid: release.releaseGroup.id,
        releaseId: release.id,
        year,
      };
      return { ...this.record(group, f, state), overlay, score: a.score };
    });
  }

  private record(group: FileGroup, f: GroupFile, state: MatchRecord['state']): MatchRecord {
    return { rel: f.rel, groupKey: group.key, state, size: f.size, mtimeMs: f.mtimeMs };
  }
}

/**
 * The files a review decision is about: those still waiting for one, so a compilation's songs already
 * matched one by one keep their match; the whole group when none is waiting.
 */
function waitingIn(group: FileGroup, matches: Map<string, MatchRecord>): GroupFile[] {
  const waiting = group.files.filter((f) => {
    const state = matches.get(f.rel)?.state;
    return !state || state === 'review' || state === 'unmatched';
  });
  return waiting.length ? waiting : group.files;
}

/** Songs by many artists under one album name: a compilation, a mixtape, a playlist's folder. */
function isCompilation(group: FileGroup): boolean {
  if (group.compilation || isVariousArtists(group.artistName)) return true;
  return new Set(group.files.map((f) => normalize(leadArtist(f.artist)))).size > 1;
}

/** Studio album first, then EP, single, soundtrack/compilation, live. */
function originalReleaseGroup(groups: AcoustIdMatch['releaseGroups']) {
  const rank = (g: AcoustIdMatch['releaseGroups'][number]) =>
    g.secondaryTypes.includes('Live') ? 6 : g.secondaryTypes.length ? 4 : g.type === 'Album' ? 0 : g.type === 'EP' ? 1 : g.type === 'Single' ? 3 : 5;
  return [...groups].sort((a, b) => rank(a) - rank(b))[0];
}

function toCandidate(s: ReleaseScore): ReviewCandidate {
  const { release } = s;
  const rg = release.releaseGroup;
  const type = [rg.primaryType, ...rg.secondaryTypes].filter(Boolean).join(' · ');
  return {
    releaseId: release.id,
    releaseGroupId: rg.id,
    title: rg.title,
    ...(release.title !== rg.title ? { releaseTitle: release.title } : {}),
    artistName: release.artistName,
    year: Number(rg.firstReleaseDate?.slice(0, 4)) || undefined,
    ...(release.date ? { date: release.date } : {}),
    ...(release.country ? { country: release.country } : {}),
    ...(release.status ? { status: release.status } : {}),
    ...(release.disambiguation ? { disambiguation: release.disambiguation } : {}),
    ...(type ? { type } : {}),
    ...(formatSummary(release.formats) ? { format: formatSummary(release.formats) } : {}),
    ...(release.labels?.length ? { labels: release.labels } : {}),
    ...(release.barcode ? { barcode: release.barcode } : {}),
    coverUrl: remoteArtUrl(coverArtArchive(rg.id)),
    detailed: !!release.detailed,
    score: Math.round(s.score * 100) / 100,
    tracks: release.tracks.map((t) => ({ disc: t.disc, position: t.position, title: t.title, duration: t.length })),
    matches: Object.fromEntries(s.alignment.map((a) => [a.rel, release.tracks.indexOf(a.track)])),
  };
}
