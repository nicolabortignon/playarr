import type { PlaylistCoverInfo, PlaylistItem } from '@playarr/shared';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Analyzer } from '../analysis/analyzer.ts';
import { FAMILIES } from '../analysis/styles.ts';
import type { Library } from '../library/library.ts';
import { buildDna, type Dna } from './dna.ts';
import { hash32, Rng } from './random.ts';
import { chooseLayout, renderCover, RENDER_VERSION } from './render.ts';

const MAX_IMAGES = 300;

/**
 * Generated playlist artwork: DNA from the songs, drawn as SVG, served as sized WebP.
 * Renders are kept in memory and on disk (some layouts simulate for seconds).
 */
export class PlaylistCovers {
  private readonly svgs = new Map<string, ReturnType<typeof renderCover>>();
  private readonly images = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly analyzer: Analyzer,
    private readonly library: Library,
    private readonly cacheDir: string,
  ) {}

  /** The playlist's DNA and cover info; queues analysis of songs not heard yet. */
  async describe(playlistId: number, items: PlaylistItem[]): Promise<{ dna: Dna; hash: string; info: PlaylistCoverInfo }> {
    const ids = items.map((i) => i.recordingId);
    this.analyzer.ensure(ids);
    const [artists, albums] = await Promise.all([this.library.artists(), this.library.albums()]);
    const genres = new Map(artists.map((a) => [a.id, a.genres]));
    const years = new Map(albums.map((a) => [a.id, a.year]));
    const dna = buildDna(
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
    const hash = hash32(`${RENDER_VERSION}:${JSON.stringify(dna)}`).toString(36);
    // Choosing the layout is cheap; drawing happens only when the image is requested.
    const layout = chooseLayout(dna, new Rng(dna.seed));
    return {
      dna,
      hash,
      info: {
        url: `/art/playlist/${playlistId}?v=${hash}`,
        layout,
        tempo: dna.tempo && Math.round(dna.tempo),
        energy: Math.round(dna.intensity * 100) / 100,
        styles: dna.styles.filter((s) => s.weight >= 0.12).slice(0, 3).map((s) => FAMILIES[s.family].label),
        era: dna.era && [dna.era.from, dna.era.to],
        analyzed: dna.analyzed,
        total: dna.total,
        pending: this.analyzer.pending(ids) > 0,
      },
    };
  }

  /** The cover's SVG; concurrent requests share one render. */
  svg(dna: Dna, hash: string) {
    let hit = this.svgs.get(hash);
    if (!hit) {
      hit = renderCover(dna);
      hit.catch(() => this.svgs.delete(hash));
      this.svgs.set(hash, hit);
      if (this.svgs.size > 40) this.svgs.delete(this.svgs.keys().next().value!);
    }
    return hit;
  }

  /** Rendered server-side, so every browser sees exactly the same pixels (filters included). */
  image(dna: Dna, hash: string, size: number): Promise<Buffer> {
    const key = `${hash}-${size}`;
    let hit = this.images.get(key);
    if (!hit) {
      const file = join(this.cacheDir, `${key}.webp`);
      hit = readFile(file).catch(async () => {
        const body = await sharp(Buffer.from((await this.svg(dna, hash)).svg), { density: (72 * size) / 1000 })
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
}
