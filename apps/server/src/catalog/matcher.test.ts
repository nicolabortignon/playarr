import { describe, expect, it, vi } from 'vitest';
import type { MbReleaseHit } from '../discover/musicbrainz.ts';
import type { AcoustIdMatch } from './acoustid.ts';
import { groupFiles, Matcher } from './matcher.ts';
import type { MbReleaseInfo } from './mbRelease.ts';
import { CatalogStore } from './store.ts';
import type { TagInfo } from './tags.ts';
import { FLAC, freshDb } from './testFixtures.ts';

const release: MbReleaseInfo = {
  id: 'rel-1',
  title: 'Mezzanine',
  artistName: 'Massive Attack',
  artistId: 'art-1',
  releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
  tracks: [
    { disc: 1, position: 1, title: 'Angel', length: 379, recordingId: 'rec-1' },
    { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
  ],
};
const hit: MbReleaseHit = { id: 'rel-1', score: 100, title: 'Mezzanine', 'track-count': 2 };
const tags = (t: Partial<TagInfo>): TagInfo => ({ genres: [], duration: 300, format: FLAC, ...t });

function setup(files: Record<string, Partial<TagInfo>>, opts: { hits?: MbReleaseHit[]; acoustid?: AcoustIdMatch | null } = {}) {
  const store = new CatalogStore(freshDb());
  const sourceId = store.addSource('folder', 'Music', { path: '/music' });
  store.saveFolderFiles(
    sourceId,
    Object.entries(files).map(([rel, t]) => ({ rel, size: 100, mtimeMs: 1, tags: tags(t) })),
    Object.keys(files),
  );
  const mb = {
    searchReleases: vi.fn(async () => opts.hits ?? [hit]),
    release: vi.fn(async () => release),
  };
  const acoustid = { enabled: opts.acoustid !== undefined, lookup: vi.fn(async () => opts.acoustid ?? null) };
  const fingerprint = vi.fn(async () => ({ duration: 379, fingerprint: 'AQAA' }));
  const onMatched = vi.fn();
  const matcher = new Matcher({ store, mb, acoustid, fingerprint, onMatched, log: { warn: () => {} } });
  return { store, sourceId, mb, acoustid, fingerprint, onMatched, matcher };
}

const mezzanineFiles = {
  'Massive Attack/Mezzanine/01 Angel.flac': { duration: 380 },
  'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 298 },
};

describe('groupFiles', () => {
  it('groups files by album, and loose files by folder; skips files already identified', () => {
    const groups = groupFiles('/music', [
      { rel: 'A/B/1.flac', size: 1, mtimeMs: 1, tags: tags({}) },
      { rel: 'A/B/2.flac', size: 1, mtimeMs: 1, tags: tags({}) },
      { rel: 'A/x.flac', size: 1, mtimeMs: 1, tags: tags({}) },
      { rel: 'A/C/1.flac', size: 1, mtimeMs: 1, tags: tags({ recordingMbid: 'r', releaseGroupMbid: 'g' }) },
    ], new Map());
    expect(groups.map((g) => [g.artistName, g.albumTitle, g.files.map((f) => f.rel)])).toEqual([
      ['A', 'B', ['A/B/1.flac', 'A/B/2.flac']],
      ['A', undefined, ['A/x.flac']],
    ]);
    expect(groups[0]!.files[0]!.path).toBe('/music/A/B/1.flac');
  });
});

describe('Matcher', () => {
  it('matches an album automatically and lays MusicBrainz ids over the files', async () => {
    const { matcher, store, sourceId, onMatched } = setup(mezzanineFiles);
    await matcher.matchSource(sourceId);
    const m = store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')!;
    expect(m).toMatchObject({ state: 'auto', overlay: { recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1', releaseId: 'rel-1', trackNumber: 1, album: 'Mezzanine', albumArtistMbid: 'art-1', year: 1998 } });
    expect(store.cachedRelease('rel-1')).toBeDefined();
    expect(onMatched).toHaveBeenCalled();
  });

  it('does nothing the second time', async () => {
    const { matcher, sourceId, mb } = setup(mezzanineFiles);
    await matcher.matchSource(sourceId);
    mb.searchReleases.mockClear();
    await matcher.matchSource(sourceId);
    expect(mb.searchReleases).not.toHaveBeenCalled();
  });

  it('asks for review when unsure', async () => {
    const { matcher, store, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')).toMatchObject({ state: 'review', candidates: ['rel-1'] });
    expect(store.matchCounts().get(sourceId)).toEqual({ review: 1 });
  });

  it('falls back to fingerprints for loose songs', async () => {
    const { matcher, store, sourceId, fingerprint } = setup(
      { 'Massive Attack/Angel.flac': {} },
      {
        hits: [],
        acoustid: {
          score: 0.95,
          recordingId: 'rec-1',
          title: 'Angel',
          artistName: 'Massive Attack',
          artistId: 'art-1',
          releaseGroups: [
            { id: 'rg-9', title: 'Collected', type: 'Album', secondaryTypes: ['Compilation'] },
            { id: 'rg-1', title: 'Mezzanine', type: 'Album', secondaryTypes: [] },
          ],
        },
      },
    );
    await matcher.matchSource(sourceId);
    expect(fingerprint).toHaveBeenCalledWith(sourceId, '/music/Massive Attack/Angel.flac');
    expect(store.matches(sourceId).get('Massive Attack/Angel.flac')).toMatchObject({
      state: 'auto',
      overlay: { recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1', album: 'Mezzanine', title: 'Angel' },
    });
  });

  it('leaves files unmatched when nothing fits', async () => {
    const { matcher, store, sourceId } = setup({ 'Someone/Demo/01 Song.flac': {} }, { hits: [] });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('Someone/Demo/01 Song.flac')!.state).toBe('unmatched');
  });

  it('applies the release the user picked, and can leave a group unmatched for good', async () => {
    const { matcher, store, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    const groupKey = store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')!.groupKey;
    await matcher.applyRelease(sourceId, groupKey, 'rel-1');
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/02 Risingson.flac')).toMatchObject({ state: 'manual', overlay: { recordingMbid: 'rec-2' } });
    matcher.ignore(sourceId, groupKey);
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')!.state).toBe('ignored');
  });

  it('describes review groups with scored candidates', async () => {
    const { matcher, store, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    const [group] = matcher.reviewGroups(sourceId);
    expect(group).toMatchObject({ artistName: 'Massive Attack', albumTitle: 'Mezzanine', files: [{ title: 'Angel' }, { title: 'Risingson' }] });
    expect(group!.candidates[0]).toMatchObject({ releaseId: 'rel-1', title: 'Mezzanine', year: 1998 });
    expect(group!.candidates[0]!.matches['Massive Attack/Mezzanine/01 Angel.flac']).toBe(0);
    expect(store.matchCounts().get(sourceId)).toEqual({ review: 1 });
  });
});
