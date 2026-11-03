import { describe, expect, it, vi } from 'vitest';
import type { MbRecordingHit, MbReleaseHit } from '../discover/musicbrainz.ts';
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

/** A compilation's song as MusicBrainz finds it: on its studio album by that artist. */
const recordingOf = (artist: string, title: string, album: string, seconds = 240): MbRecordingHit => ({
  id: `rec-${title}`,
  score: 100,
  title,
  length: seconds * 1000,
  'artist-credit': [{ name: artist, artist: { id: `art-${artist}`, name: artist } }],
  releases: [
    {
      id: `rel-${album}`,
      title: album,
      status: 'Official',
      date: '2002-07-09',
      'release-group': { id: `rg-${album}`, title: album, 'primary-type': 'Album', 'secondary-types': [] },
      media: [{ position: 1, 'track-offset': 0, track: [{ id: 't', number: '1' }] }],
    },
  ],
});

const hitsFolder = {
  '01. Red Hot Chili Peppers - Can’t Stop.mp3': { artist: 'Red Hot Chili Peppers', title: 'Can’t Stop', duration: 240 },
  '03. Coldplay - Yellow.mp3': { artist: 'Coldplay', title: 'Yellow', duration: 240 },
  '99. Nobody - Unknown.mp3': { artist: 'Nobody', title: 'Unknown', duration: 240 },
};
const hitsTags = (t: Partial<TagInfo>) => ({ ...t, albumArtist: 'Various Artists', album: '00s Hits - 100 Top Songs' });
const albums: Record<string, string> = { 'Can’t Stop': 'By the Way', Yellow: 'Parachutes' };

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
    expect(store.matchCounts().get(sourceId)).toEqual({ matched: 0, review: 1, ignored: 0 });
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

  it('matches a compilation no release fits song by song, each under its own album', async () => {
    const files = Object.fromEntries(Object.entries(hitsFolder).map(([rel, t]) => [rel, hitsTags(t)]));
    const { matcher, store, sourceId, mb } = setup(files, { hits: [] });
    const searchRecordings = vi.fn(async (artist: string, title: string) => (albums[title] ? [recordingOf(artist, title, albums[title])] : []));
    Object.assign(mb, { searchRecordings });
    await matcher.matchSource(sourceId);
    expect(searchRecordings).toHaveBeenCalledWith('Coldplay', 'Yellow', 240);
    expect(store.matches(sourceId).get('03. Coldplay - Yellow.mp3')).toMatchObject({
      state: 'auto',
      overlay: { recordingMbid: 'rec-Yellow', album: 'Parachutes', albumArtist: 'Coldplay', releaseGroupMbid: 'rg-Parachutes', trackNumber: 1 },
    });
    // Just the song: no release, so the album's other songs aren't listed as missing.
    expect(store.matches(sourceId).get('03. Coldplay - Yellow.mp3')!.overlay!.releaseId).toBeUndefined();
    expect(store.matches(sourceId).get('99. Nobody - Unknown.mp3')!.state).toBe('unmatched');

    // The song left over goes up for review alone; ignoring it leaves the others matched.
    const [group, ...more] = matcher.reviewGroups(sourceId);
    expect(more).toEqual([]);
    expect(group).toMatchObject({ artistName: 'Nobody', albumTitle: '00s Hits - 100 Top Songs', notFound: true });
    expect(group!.files.map((f) => f.rel)).toEqual(['99. Nobody - Unknown.mp3']);
    matcher.ignore(sourceId, group!.groupKey);
    expect(store.matches(sourceId).get('99. Nobody - Unknown.mp3')!.state).toBe('ignored');
    expect(store.matches(sourceId).get('01. Red Hot Chili Peppers - Can’t Stop.mp3')).toMatchObject({ state: 'auto', overlay: { album: 'By the Way' } });
  });

  it('finds a compilation’s radio edit on its album with a wider search, and the rest by their sound', async () => {
    const files = {
      '57. Madonna - Die Another Day.mp3': hitsTags({ artist: 'Madonna', title: 'Die Another Day (From "Die Another Day")', duration: 240 }),
      '68. Rupee - Tempted to Touch.mp3': hitsTags({ artist: 'Rupee', title: 'Tempted to Touch', duration: 243 }),
      '03. Coldplay - Yellow.mp3': hitsTags({ artist: 'Coldplay', title: 'Yellow', duration: 240 }),
    };
    const { matcher, store, sourceId, mb, acoustid, fingerprint } = setup(files, {
      hits: [],
      acoustid: {
        score: 0.95,
        recordingId: 'rec-ttt',
        title: 'Tempted to Touch',
        artistName: 'Rupee',
        artistId: 'art-rupee',
        releaseGroups: [
          { id: 'rg-hits', title: 'Soca Gold 2003', type: 'Album', secondaryTypes: ['Compilation'] },
          { id: 'rg-xmas', title: 'Jule CD’n 2000', type: 'Album', secondaryTypes: [], artistName: 'Various Artists' },
          { id: 'rg-1o1', title: '1 on 1', type: 'Album', secondaryTypes: [] },
        ],
      },
    });
    const searchRecordings = vi.fn(async (artist: string, title: string, seconds: number) => {
      // The album version runs 4:38: only the search without a length finds it.
      if (title === 'Die Another Day') return seconds ? [] : [recordingOf(artist, title, 'American Life', 278)];
      return title === 'Yellow' ? [recordingOf(artist, title, 'Parachutes')] : [];
    });
    Object.assign(mb, { searchRecordings });
    await matcher.matchSource(sourceId);
    expect(searchRecordings).toHaveBeenCalledWith('Madonna', 'Die Another Day', 0);
    expect(store.matches(sourceId).get('57. Madonna - Die Another Day.mp3')).toMatchObject({ state: 'auto', overlay: { album: 'American Life', albumArtist: 'Madonna' } });
    // Not found by name: by its sound, on the artist's own album rather than another compilation.
    expect(store.matches(sourceId).get('68. Rupee - Tempted to Touch.mp3')).toMatchObject({ state: 'auto', overlay: { album: '1 on 1', releaseGroupMbid: 'rg-1o1' } });
    // Songs found by name aren't fingerprinted.
    expect(fingerprint).toHaveBeenCalledTimes(1);
    expect(fingerprint).toHaveBeenCalledWith(sourceId, '/music/68. Rupee - Tempted to Touch.mp3');
    expect(acoustid.lookup).toHaveBeenCalledTimes(1);
    expect(store.matches(sourceId).get('03. Coldplay - Yellow.mp3')).toMatchObject({ overlay: { album: 'Parachutes' } });
  });

  it('files a radio edit found only on its single under its studio album', async () => {
    const files = { '10. Madonna - 4 Minutes.mp3': hitsTags({ artist: 'Madonna', title: '4 Minutes', duration: 189 }) };
    const { matcher, store, sourceId, mb } = setup(files, { hits: [] });
    const single = recordingOf('Madonna', '4 Minutes', '4 Minutes', 189);
    single.releases![0]!['release-group']!['primary-type'] = 'Single';
    Object.assign(mb, {
      searchRecordings: vi.fn(async (artist: string, title: string, seconds: number) => (seconds ? [single] : [single, recordingOf(artist, title, 'Hard Candy', 245)])),
    });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('10. Madonna - 4 Minutes.mp3')).toMatchObject({ overlay: { album: 'Hard Candy' } });
  });

  it('keeps the songs found when MusicBrainz fails for one, and tries that one again after the next scan', async () => {
    const files = Object.fromEntries(Object.entries(hitsFolder).map(([rel, t]) => [rel, hitsTags(t)]));
    const { matcher, store, sourceId, mb } = setup(files, { hits: [] });
    const searchRecordings = vi.fn(async (artist: string, title: string) => {
      if (title === 'Yellow') throw new Error('MusicBrainz 503 for /recording');
      return albums[title] ? [recordingOf(artist, title, albums[title])] : [];
    });
    Object.assign(mb, { searchRecordings });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('01. Red Hot Chili Peppers - Can’t Stop.mp3')!.state).toBe('auto');
    expect(store.matches(sourceId).has('03. Coldplay - Yellow.mp3')).toBe(false);
    searchRecordings.mockClear();
    await matcher.matchSource(sourceId);
    expect(searchRecordings.mock.calls).toEqual([['Coldplay', 'Yellow', 240]]);
  });

  it('lists a compilation’s songs for review one by one, even those matched when it was one group', async () => {
    const files = Object.fromEntries(Object.entries(hitsFolder).map(([rel, t]) => [rel, hitsTags(t)]));
    const { matcher, store, sourceId } = setup(files);
    // As an earlier version saved them: one group for the whole compilation.
    store.saveMatches(
      sourceId,
      Object.keys(files).map((rel) => ({ rel, groupKey: 'various artists|00s hits 100 top songs', state: 'unmatched' as const, size: 100, mtimeMs: 1 })),
    );
    expect(matcher.reviewGroups(sourceId).map((g) => [g.artistName, g.files.length])).toEqual([
      ['Red Hot Chili Peppers', 1],
      ['Coldplay', 1],
      ['Nobody', 1],
    ]);
  });

  it('tells a compilation by its songs’ artists, whoever the album artist is', async () => {
    const files = {
      'Mix/01 Yellow.mp3': { artist: 'Coldplay', title: 'Yellow', album: 'Summer mix', albumArtist: 'Me', duration: 240 },
      'Mix/02 Can’t Stop.mp3': { artist: 'Red Hot Chili Peppers', title: 'Can’t Stop', album: 'Summer mix', albumArtist: 'Me', duration: 240 },
    };
    const { matcher, store, sourceId, mb } = setup(files);
    Object.assign(mb, { searchRecordings: vi.fn(async (artist: string, title: string) => [recordingOf(artist, title, albums[title]!)]) });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('Mix/02 Can’t Stop.mp3')).toMatchObject({ state: 'auto', overlay: { album: 'By the Way' } });
  });

  it('keeps one artist’s album MusicBrainz half knows together, for review', async () => {
    const files = {
      'Coldplay/Demos/01 Yellow.mp3': { artist: 'Coldplay', title: 'Yellow', album: 'Demos', duration: 240 },
      'Coldplay/Demos/02 Shiver demo.mp3': { artist: 'Coldplay', title: 'Shiver demo', album: 'Demos' },
      'Coldplay/Demos/03 Untitled.mp3': { artist: 'Coldplay', title: 'Untitled', album: 'Demos' },
    };
    const { matcher, store, sourceId, mb } = setup(files, { hits: [] });
    Object.assign(mb, { searchRecordings: vi.fn(async (artist: string, title: string) => (albums[title] ? [recordingOf(artist, title, albums[title])] : [])) });
    await matcher.matchSource(sourceId);
    expect([...store.matches(sourceId).values()].map((m) => m.state)).toEqual(['unmatched', 'unmatched', 'unmatched']);
  });

  it('leaves files unmatched when nothing fits', async () => {
    const { matcher, store, sourceId } = setup({ 'Someone/Demo/01 Song.flac': {} }, { hits: [] });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('Someone/Demo/01 Song.flac')!.state).toBe('unmatched');
  });

  it('finds an album whose files call the artist by another name MusicBrainz knows them by', async () => {
    const { matcher, store, sourceId, mb } = setup(mezzanineFiles, { hits: [] });
    const extra = {
      searchArtists: vi.fn(async () => [{ id: 'art-1', score: 100 }]),
      searchReleasesOfArtist: vi.fn(async () => [hit]),
    };
    Object.assign(mb, extra);
    await matcher.matchSource(sourceId);
    expect(extra.searchReleasesOfArtist).toHaveBeenCalledWith('art-1', 'Mezzanine');
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')!.state).toBe('auto');
  });

  it('puts albums found nowhere on MusicBrainz up for review, where their names can be fixed', async () => {
    const files = { 'N Sync/No Strings Attached/03 Bye Bye Bye.flac': { album: 'No Strings Attached', artist: 'N Sync', title: 'Bye Bye Bye' } };
    const { matcher, store, sourceId, onMatched } = setup(files, { hits: [] });
    await matcher.matchSource(sourceId);
    const [group] = matcher.reviewGroups(sourceId);
    expect(group).toMatchObject({ artistName: 'N Sync', albumTitle: 'No Strings Attached', candidates: [], notFound: true });
    expect(store.matchCounts().get(sourceId)).toEqual({ matched: 0, review: 1, ignored: 0 });
    onMatched.mockClear();
    matcher.rename(sourceId, group!.groupKey, {
      artist: '*NSYNC',
      album: 'No Strings Attached',
      titles: { 'N Sync/No Strings Attached/03 Bye Bye Bye.flac': 'Bye Bye Bye (Radio Edit)' },
    });
    expect(store.matches(sourceId).get('N Sync/No Strings Attached/03 Bye Bye Bye.flac')).toMatchObject({
      state: 'manual',
      overlay: { albumArtist: '*NSYNC', album: 'No Strings Attached', title: 'Bye Bye Bye (Radio Edit)' },
    });
    expect(matcher.reviewGroups(sourceId)).toEqual([]);
    expect(onMatched).toHaveBeenCalled();
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

  it('matches a file’s album again from scratch, even over the user’s own decision', async () => {
    const { matcher, store, sourceId, mb, onMatched } = setup(mezzanineFiles);
    await matcher.matchSource(sourceId);
    const rel = 'Massive Attack/Mezzanine/01 Angel.flac';
    matcher.ignore(sourceId, store.matches(sourceId).get(rel)!.groupKey);
    expect(store.matches(sourceId).get(rel)!.state).toBe('ignored');
    const searches = mb.searchReleases.mock.calls.length;
    onMatched.mockClear();
    expect(await matcher.rematchFile(sourceId, rel)).toBe('auto');
    expect(mb.searchReleases.mock.calls.length).toBe(searches + 1);
    // The whole album group was matched again, not only the one file.
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/02 Risingson.flac')).toMatchObject({ state: 'auto', overlay: { recordingMbid: 'rec-2' } });
    expect(onMatched).toHaveBeenCalled();
    await expect(matcher.rematchFile(sourceId, 'gone.flac')).rejects.toThrow(/isn’t in its folder/);
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
    expect(store.matchCounts().get(sourceId)).toEqual({ matched: 0, review: 1, ignored: 0 });
  });

  it('shows what MusicBrainz knows about each edition, fetching details missing from the cache', async () => {
    const { matcher, mb, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    expect(matcher.reviewGroups(sourceId)[0]!.candidates[0]).not.toHaveProperty('country');
    expect(matcher.reviewGroups(sourceId)[0]!.candidates[0]!.detailed).toBe(false);
    mb.release.mockResolvedValueOnce({
      ...release,
      title: 'Mezzanine (Deluxe)',
      date: '2019-04-19',
      country: 'GB',
      status: 'Official',
      disambiguation: '21st anniversary',
      labels: [{ name: 'Virgin', catalogNumber: 'WBRX4' }],
      formats: ['CD', 'CD'],
      releaseGroup: { ...release.releaseGroup, secondaryTypes: ['Remix'] },
      detailed: true,
    });
    await matcher.refreshReviewDetails(sourceId);
    expect(matcher.reviewGroups(sourceId)[0]!.candidates[0]).toMatchObject({
      releaseGroupId: 'rg-1',
      title: 'Mezzanine',
      releaseTitle: 'Mezzanine (Deluxe)',
      artistName: 'Massive Attack',
      year: 1998,
      date: '2019-04-19',
      country: 'GB',
      status: 'Official',
      disambiguation: '21st anniversary',
      type: 'Album · Remix',
      format: '2×CD',
      labels: [{ name: 'Virgin', catalogNumber: 'WBRX4' }],
      coverUrl: expect.stringContaining('/art/remote?url='),
    });
    expect(matcher.reviewGroups(sourceId)[0]!.candidates[0]!.detailed).toBe(true);
    // Cached with details now: no second fetch.
    const calls = mb.release.mock.calls.length;
    await matcher.refreshReviewDetails(sourceId);
    expect(mb.release.mock.calls.length).toBe(calls);
  });

  it('fetches details in the background, one refresh at a time per source', async () => {
    const { matcher, mb, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    let finish: (r: MbReleaseInfo) => void = () => {};
    mb.release.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const before = mb.release.mock.calls.length;
    matcher.refreshReviewDetailsSoon(sourceId);
    matcher.refreshReviewDetailsSoon(sourceId);
    expect(mb.release.mock.calls.length).toBe(before + 1);
    expect(matcher.reviewGroups(sourceId)[0]!.candidates[0]!.detailed).toBe(false);
    finish({ ...release, detailed: true });
    await vi.waitFor(() => expect(matcher.reviewGroups(sourceId)[0]!.candidates[0]!.detailed).toBe(true));
  });
});
