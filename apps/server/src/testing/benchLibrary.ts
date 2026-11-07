/**
 * Plan 3 §1's measurements, to take again after a change: `pnpm -C apps/server bench:library`, with
 * `--tracks 100000` (the size), `--source folder|lidarr|both`, `--runs 5` (repeats of the quick steps) and
 * `--json <file>` to keep the numbers. A synthetic library (syntheticLibrary.ts) goes through the real refresh
 * path into a real database file: a folder source reading it from a stand-in filesystem, with the matcher looking
 * at what each scan found (as a server whose matching is done: MusicBrainz knows none of it), or a Lidarr source
 * handing over what Lidarr would report. Then: the first refreshes (until a folder's catalog settles), refreshes with
 * nothing changed, one after a tag edit, the albums and artists lists (whole, paged, and asked again with their
 * ETag), a dozen searches, memory, and the event-loop stalls the server's stall monitor would log (it warns from
 * 500 ms). Each source runs in a process of its own, so memory is its own.
 * Big runs belong here, not in the test run: tests use a small size.
 */
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Fastify from 'fastify';
import { buildCatalog } from '../catalog/build.ts';
import { FolderSource } from '../catalog/folderSource.ts';
import { Matcher } from '../catalog/matcher.ts';
import { CatalogStore } from '../catalog/store.ts';
import type { CatalogSource, SourceSync } from '../catalog/types.ts';
import type { Config } from '../config.ts';
import { openDatabase } from '../db.ts';
import { Library } from '../library/library.ts';
import { LidarrClient } from '../lidarr/client.ts';
import type { MediaSource } from '../media/index.ts';
import { apiRoutes } from '../routes/api.ts';
import { syntheticFolderFs, syntheticLibrary, type SyntheticLibrary } from './syntheticLibrary.ts';

const { values: args } = parseArgs({
  options: {
    tracks: { type: 'string', default: '100000' },
    source: { type: 'string', default: 'both' },
    runs: { type: 'string', default: '5' },
    json: { type: 'string' },
  },
});
const TRACKS = Number(args.tracks);
const RUNS = Math.max(1, Number(args.runs));
/** The stall monitor (stallMonitor.ts) warns when the event loop was blocked this long. */
const STALL_MS = 500;

interface Timed {
  ms: number;
  /** The longest the event loop was blocked meanwhile. */
  stallMs: number;
}

interface Row {
  step: string;
  ms: number;
  stallMs?: number;
  note?: string;
}

/** Times `fn`, and the longest the event loop was blocked while it ran (as the stall monitor measures it). */
async function timed<T>(fn: () => Promise<T> | T): Promise<Timed & { value: T }> {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  // The monitor's timer starts on the next turn of the loop: a block before then would go unseen.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  // Let the monitor's timer fire once more, so a block at the very end is counted too.
  await new Promise((resolve) => setTimeout(resolve, 30));
  delay.disable();
  return { ms, stallMs: delay.max / 1e6, value };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const mb = (bytes: number) => Math.round(bytes / 1048576);
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const fmt = (ms: number) => (Number.isNaN(ms) ? '' : ms >= 100 ? `${Math.round(ms)}` : ms.toFixed(1));

/** MusicBrainz knowing none of the library: every lookup comes back empty at once, so matching finds nothing. */
const nobodyKnows = {
  searchReleases: async () => [],
  release: async (): Promise<never> => {
    throw new Error('not found');
  },
  searchArtists: async () => [],
  searchReleasesOfArtist: async () => [],
  searchRecordings: async () => [],
};

async function bench(mode: 'folder' | 'lidarr', lib: SyntheticLibrary): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (step: string, t: Timed, note?: string) => rows.push({ step, ms: t.ms, stallMs: t.stallMs, ...(note ? { note } : {}) });
  const dir = mkdtempSync(join(tmpdir(), 'playarr-bench-'));
  const db = openDatabase(dir);
  try {
    const store = new CatalogStore(db);
    let source: CatalogSource;
    let sourceId: number;
    let edit: () => void;
    let matcher: Matcher | undefined;
    if (mode === 'folder') {
      sourceId = store.addSource('folder', 'Synthetic', { path: lib.root });
      const fs = syntheticFolderFs(lib);
      matcher = new Matcher({ store, mb: nobodyKnows, onMatched: () => {}, log: { warn: () => {} }, retry: { times: 0, afterMs: 0 } });
      source = new FolderSource({ sourceId, root: lib.root, store, fs, onScanned: (id, digest) => matcher!.enqueue(id, digest) });
      edit = () => {
        const file = lib.files[Math.floor(lib.files.length / 2)]!;
        file.tags = { ...file.tags, title: `${file.tags.title ?? 'Untitled'} (edited)` };
        file.mtimeMs += 1000;
      };
    } else {
      sourceId = store.addSource('lidarr', 'Synthetic');
      // Made up once: what's timed is Playarr's work on Lidarr's answer. An edit is a new answer, as Lidarr's are.
      let sync: SourceSync = lib.lidarr();
      source = { kind: 'lidarr', sync: async () => sync };
      edit = () => {
        const at = Math.floor(sync.tracks.length / 2);
        sync = { ...sync, tracks: sync.tracks.map((t, i) => (i === at ? { ...t, title: `${t.title} (edited)` } : t)) };
      };
    }
    const errors: string[] = [];
    const library = new Library(store, () => [{ id: sourceId, source }], { info: () => {}, error: (m) => errors.push(m) });
    /** Matching runs after each scan: wait for it to finish looking, as a server would. */
    const settled = async (which = matcher) => {
      while (which && which.pendingGroups(sourceId) > 0) await new Promise((resolve) => setTimeout(resolve, 20));
    };

    add('first refresh', await timed(() => library.refresh()));
    if (errors.length) throw new Error(errors.join('; '));
    await settled();
    // The second scan of a folder files its untagged songs with what the first one found (and what matching left);
    // the scan after a change reads the folder again in full, as the catalog its songs join has moved.
    add('second refresh', await timed(() => library.refresh()));
    await settled();
    add('third refresh (the scan after a change)', await timed(() => library.refresh()));
    await settled();
    const stats = (await library.stats())!;
    gc();
    const memory = process.memoryUsage();
    rows.push({ step: 'memory after the build', ms: NaN, note: `RSS ${mb(memory.rss)} MB, heap ${mb(memory.heapUsed)} MB` });
    rows.push({ step: 'library', ms: NaN, note: `${stats.artists} artists, ${stats.albums} albums, ${stats.tracks} songs` });

    const quiet: Timed[] = [];
    for (let i = 0; i < RUNS; i++) {
      quiet.push(await timed(() => library.refresh()));
      await settled();
    }
    rows.push({
      step: 'refresh, nothing changed',
      ms: median(quiet.map((t) => t.ms)),
      stallMs: Math.max(...quiet.map((t) => t.stallMs)),
      note: `median of ${quiet.map((t) => fmt(t.ms)).join(', ')}`,
    });

    // A restart, as every update is: the stored catalog is served at once, then the first refresh has no last sync
    // in memory to go by, so it reads the source in full and compares every row (writing nothing).
    {
      const restartedStore = new CatalogStore(db);
      const restartedMatcher =
        mode === 'folder'
          ? new Matcher({ store: restartedStore, mb: nobodyKnows, onMatched: () => {}, log: { warn: () => {} }, retry: { times: 0, afterMs: 0 } })
          : undefined;
      const restartedSource = restartedMatcher
        ? new FolderSource({ sourceId, root: lib.root, store: restartedStore, fs: syntheticFolderFs(lib), onScanned: (id, digest) => restartedMatcher.enqueue(id, digest) })
        : source;
      const restarted = new Library(restartedStore, () => [{ id: sourceId, source: restartedSource }], { info: () => {}, error: (m) => errors.push(m) });
      add('after a restart: the stored catalog served', await timed(() => restarted.loadStored()));
      add('after a restart: the first refresh, nothing changed', await timed(() => restarted.refresh()));
      await settled(restartedMatcher);
      add('after a restart: the next refresh', await timed(() => restarted.refresh()));
      await settled(restartedMatcher);
      if (errors.length) throw new Error(errors.join('; '));
    }

    edit();
    add('refresh after one tag edit', await timed(() => library.refresh()));
    await settled();

    // Where the time of a refresh goes, each part on its own.
    if (mode === 'folder') {
      const scan = new FolderSource({ sourceId, root: lib.root, store, fs: syntheticFolderFs(lib) });
      add('  part: a full folder scan (tags cached)', await timed(() => scan.sync()));
      add('  part: the matcher’s look at the scan', await timed(() => matcher!.matchSource(sourceId)));
    }
    const loaded = await timed(() => store.load());
    add('  part: loading the catalog from SQLite', loaded);
    add('  part: building the catalog', await timed(() => buildCatalog(loaded.value)));

    const app = Fastify();
    apiRoutes(app, {
      config: { pathMap: [] } as unknown as Config,
      lidarr: new LidarrClient(),
      library,
      media: { kind: 'local', check: async () => {} } as unknown as MediaSource,
      requestSettings: () => ({ enabled: false, searchOnAdd: true }),
    });
    const get = async (url: string, headers: Record<string, string> = {}) => {
      const t = await timed(() => app.inject({ method: 'GET', url, headers }));
      return { ...t, status: t.value.statusCode, bytes: t.value.rawPayload.length, etag: t.value.headers.etag as string | undefined };
    };
    const route = async (label: string, url: string) => {
      const first = await get(url);
      const again: number[] = [];
      for (let i = 0; i < RUNS; i++) again.push((await get(url)).ms);
      rows.push({ step: `${label}, first`, ms: first.ms, stallMs: first.stallMs, note: `${Math.round(first.bytes / 1024)} KB` });
      rows.push({ step: `${label}, again`, ms: median(again), note: `median of ${RUNS}` });
      if (first.etag) {
        const revalidated = await get(url, { 'if-none-match': first.etag });
        rows.push({ step: `${label}, If-None-Match`, ms: revalidated.ms, note: `answers ${revalidated.status}` });
      }
    };
    for (const sort of ['artist', 'title', 'year', 'added']) await route(`GET /api/albums?sort=${sort}`, `/api/albums?sort=${sort}`);
    await route('GET /api/albums?sort=artist&offset=0&limit=100', '/api/albums?sort=artist&offset=0&limit=100');
    await route('GET /api/albums?sort=artist&offset=6000&limit=100', '/api/albums?sort=artist&offset=6000&limit=100');
    await route('GET /api/artists', '/api/artists');
    await route('GET /api/artists?offset=0&limit=100', '/api/artists?offset=0&limit=100');

    // Search: the first search after a change, then each query as people type it.
    edit();
    await library.refresh();
    await settled();
    const first = await get(`/api/search?q=${encodeURIComponent(lib.queries[0]!.q)}`);
    rows.push({ step: 'search, the first after a change', ms: first.ms, stallMs: first.stallMs });
    let worst = 0;
    for (const { label, q } of lib.queries) {
      const times: number[] = [];
      let found = '';
      for (let i = 0; i < RUNS; i++) {
        const res = await get(`/api/search?q=${encodeURIComponent(q)}`);
        times.push(res.ms);
        const body = res.value.json() as { artists: unknown[]; albums: unknown[]; tracks: unknown[]; near?: boolean };
        found = `${body.artists.length}/${body.albums.length}/${body.tracks.length}${body.near ? ' near' : ''}`;
      }
      worst = Math.max(worst, ...times);
      rows.push({ step: `search “${q}” (${label})`, ms: median(times), note: `artists/albums/songs ${found}` });
    }
    rows.push({ step: 'search, slowest of all', ms: worst });

    // An account limited to some sources sees a view of its own, built on its first request after a change.
    const view = library.view([sourceId]);
    add('a limited account’s first search after a change', await timed(() => view.search(lib.queries[0]!.q)));
    await app.close();
    return rows;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function print(mode: string, rows: Row[], files: number) {
  const stalls = rows.filter((r) => (r.stallMs ?? 0) >= STALL_MS).length;
  console.log(`\n### ${mode === 'folder' ? 'Folder source' : 'Lidarr source'} (${files.toLocaleString('en')} files)\n`);
  console.log('| step | ms | longest stall, ms | |');
  console.log('|---|---:|---:|---|');
  for (const r of rows) console.log(`| ${r.step} | ${fmt(r.ms)} | ${r.stallMs === undefined ? '' : fmt(r.stallMs)} | ${r.note ?? ''} |`);
  console.log(`\nSteps that blocked the event loop for ${STALL_MS} ms or more (the stall monitor would warn): ${stalls}`);
}

if (args.source === 'both') {
  // One process per source, each with this one's settings, writing its numbers for this one to keep.
  console.log(`Synthetic library: ${TRACKS.toLocaleString('en')} songs, ${RUNS} runs of the quick steps`);
  const results: Record<string, unknown> = {};
  for (const mode of ['folder', 'lidarr']) {
    const out = join(tmpdir(), `playarr-bench-${process.pid}-${mode}.json`);
    const child = fork(fileURLToPath(import.meta.url), ['--tracks', String(TRACKS), '--runs', String(RUNS), '--source', mode, '--json', out], {
      execArgv: process.execArgv,
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    if (code !== 0) process.exit(code ?? 1);
    results[mode] = JSON.parse(readFileSync(out, 'utf8')).results[mode];
    rmSync(out, { force: true });
  }
  if (args.json) writeFileSync(args.json, `${JSON.stringify({ tracks: TRACKS, runs: RUNS, node: process.version, results }, null, 2)}\n`);
} else {
  const mode = args.source as 'folder' | 'lidarr';
  if (mode !== 'folder' && mode !== 'lidarr') throw new Error('--source is folder, lidarr or both');
  const lib = syntheticLibrary({ tracks: TRACKS });
  const rows = await bench(mode, lib);
  print(mode, rows, lib.counts.files);
  if (!(globalThis as { gc?: unknown }).gc) console.log('(run with --expose-gc for steady memory figures)');
  if (args.json) writeFileSync(args.json, `${JSON.stringify({ tracks: TRACKS, runs: RUNS, node: process.version, results: { [mode]: rows } }, null, 2)}\n`);
}
