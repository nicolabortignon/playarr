import type { CoverLayout, PlaylistCoverInfo, PlaylistItem } from '@playarr/shared';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Analyzer } from '../analysis/analyzer.ts';
import { FAMILIES } from '../analysis/styles.ts';
import type { Library } from '../library/library.ts';
import { buildDna, type Dna } from './dna.ts';
import { hash32, Rng } from './random.ts';
import { chooseLayout, composeCover, drawArt, RENDER_VERSION, type Art } from './render.ts';

const MAX_IMAGES = 300;
/** Share of songs that may change before the cover is flagged as out of date. */
const STALE_AFTER = 0.3;

/** What a cover was drawn from: frozen per playlist, so it changes only when the user asks. */
export interface CoverSnapshot {
  dna: Dna;
  layout: CoverLayout;
  variant: number;
  /** Sorted recording ids at drawing time, to tell when the playlist has drifted. */
  songs: string[];
  drawnAt: string;
}

/** A cover to draw: the music (DNA), the layout and the variation. */
export interface CoverArt {
  dna: Dna;
  layout: CoverLayout;
  variant: number;
}

interface Playlist {
  id: number;
  name: string;
  items: PlaylistItem[];
  snapshot?: CoverSnapshot;
}

/**
 * Generated playlist artwork. A playlist's cover is drawn once its songs have been analyzed and
 * then frozen (a snapshot of its DNA, layout and variant); it changes only when the user picks a
 * new one. The title is a separate, live layer, so renaming never redraws the art.
 * Renders are kept in memory and on disk (some layouts simulate for seconds).
 */
export class PlaylistCovers {
  private readonly arts = new Map<string, Promise<Art>>();
  private readonly images = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly analyzer: Analyzer,
    private readonly library: Library,
    private readonly cacheDir: string,
  ) {}

  /**
   * Cover info for a playlist. Returns `freeze` when the cover should be pinned now: the first
   * time all of its songs have been heard.
   */
  async describe(playlist: Playlist): Promise<{ info: PlaylistCoverInfo; art: CoverArt; version: string; freeze?: CoverSnapshot }> {
    const ids = playlist.items.map((i) => i.recordingId);
    const songs = [...new Set(ids)].sort();
    const live = await this.liveDna(playlist.id, playlist.items);
    const pending = this.analyzer.pending(ids) > 0;

    let snapshot = playlist.snapshot;
    let freeze: CoverSnapshot | undefined;
    if (!snapshot && songs.length && !pending) {
      freeze = snapshot = this.snapshot(live, chooseLayout(live, new Rng(live.seed)), 0);
    }
    const art: CoverArt = snapshot ?? { dna: live, layout: chooseLayout(live, new Rng(live.seed)), variant: 0 };
    const version = hash32(`${artKey(art)}|${playlist.name}`).toString(36);
    const { dna } = art;
    return {
      art,
      version,
      freeze,
      info: {
        url: `/art/playlist/${playlist.id}?v=${version}`,
        layout: art.layout,
        variant: art.variant,
        frozen: !!snapshot,
        stale: !!snapshot && drift(snapshot.songs, songs) > STALE_AFTER,
        tempo: dna.tempo && Math.round(dna.tempo),
        energy: Math.round(dna.intensity * 100) / 100,
        styles: dna.styles.filter((s) => s.weight >= 0.12).slice(0, 3).map((s) => FAMILIES[s.family].label),
        era: dna.era && [dna.era.from, dna.era.to],
        analyzed: live.analyzed,
        total: live.total,
        pending,
      },
    };
  }

  /** DNA of the playlist's songs as they are now; queues analysis of songs not heard yet. */
  async liveDna(playlistId: number, items: PlaylistItem[]): Promise<Dna> {
    const ids = items.map((i) => i.recordingId);
    this.analyzer.ensure(ids);
    const [artists, albums] = await Promise.all([this.library.artists(), this.library.albums()]);
    const genres = new Map(artists.map((a) => [a.id, a.genres]));
    const years = new Map(albums.map((a) => [a.id, a.year]));
    return buildDna(
      items.map((i) => ({
        recordingId: i.recordingId,
        duration: i.track?.duration,
        genres: i.track ? genres.get(i.track.artistId) : undefined,
        year: i.track ? years.get(i.track.albumId) : undefined,
      })),
      this.analyzer.features(ids),
      this.analyzer.meta(ids),
      String(playlistId),
    );
  }

  snapshot(dna: Dna, layout: CoverLayout, variant: number): CoverSnapshot {
    const songs = [...new Set(dna.glyphs.map((g) => g.id))].sort();
    return { dna, layout, variant, songs, drawnAt: new Date().toISOString() };
  }

  /** The cover as WebP, with or without the title. Rendered server-side so every browser sees the same pixels. */
  image(art: CoverArt, title: string | undefined, size: number): Promise<Buffer> {
    const key = `${artKey(art)}-${title ? hash32(title).toString(36) : 'plain'}-${size}`;
    let hit = this.images.get(key);
    if (!hit) {
      const file = join(this.cacheDir, `${key}.webp`);
      hit = readFile(file).catch(async () => {
        const body = await sharp(Buffer.from(await this.svg(art, title)), { density: (72 * size) / 1000 })
          .resize(size, size)
          .webp({ quality: 86 })
          .toBuffer();
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(file, body).catch(() => undefined);
        return body;
      });
      hit.catch(() => this.images.delete(key));
      this.images.set(key, hit);
      if (this.images.size > MAX_IMAGES) this.images.delete(this.images.keys().next().value!);
    }
    return hit;
  }

  async svg(art: CoverArt, title?: string): Promise<string> {
    return composeCover(await this.draw(art), title);
  }

  /** The artwork; concurrent requests share one render. */
  private draw(art: CoverArt): Promise<Art> {
    const key = artKey(art);
    let hit = this.arts.get(key);
    if (!hit) {
      hit = drawArt(art.dna, art.layout, art.variant);
      hit.catch(() => this.arts.delete(key));
      this.arts.set(key, hit);
      if (this.arts.size > 40) this.arts.delete(this.arts.keys().next().value!);
    }
    return hit;
  }
}

function artKey(art: CoverArt): string {
  return hash32(`${RENDER_VERSION}:${art.layout}:${art.variant}:${JSON.stringify(art.dna)}`).toString(36);
}

/** Share of songs added or removed since `before` (Jaccard distance). */
function drift(before: string[], now: string[]): number {
  const a = new Set(before);
  const b = new Set(now);
  const union = new Set([...a, ...b]).size;
  if (!union) return 0;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared++;
  return 1 - shared / union;
}
