import type { PlaylistCoverInfo, PlaylistItem } from '@playarr/shared';
import sharp from 'sharp';
import type { Analyzer } from '../analysis/analyzer.ts';
import { FAMILIES } from '../analysis/styles.ts';
import type { Library } from '../library/library.ts';
import { buildDna, type Dna } from './dna.ts';
import { hash32 } from './random.ts';
import { renderCover, RENDER_VERSION } from './render.ts';

const MAX_IMAGES = 300;

/** Generated playlist artwork: DNA from the songs, drawn as SVG, served as sized WebP. */
export class PlaylistCovers {
  private readonly svgs = new Map<string, ReturnType<typeof renderCover>>();
  private readonly images = new Map<string, Buffer>();

  constructor(
    private readonly analyzer: Analyzer,
    private readonly library: Library,
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
    const { layout } = this.svg(dna, hash);
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

  svg(dna: Dna, hash: string) {
    let hit = this.svgs.get(hash);
    if (!hit) {
      hit = renderCover(dna);
      this.svgs.set(hash, hit);
      if (this.svgs.size > MAX_IMAGES) this.svgs.delete(this.svgs.keys().next().value!);
    }
    return hit;
  }

  /** Rendered server-side, so every browser sees exactly the same pixels (filters included). */
  async image(dna: Dna, hash: string, size: number): Promise<Buffer> {
    const key = `${hash}:${size}`;
    let hit = this.images.get(key);
    if (!hit) {
      hit = await sharp(Buffer.from(this.svg(dna, hash).svg), { density: (72 * size) / 1000 })
        .resize(size, size)
        .webp({ quality: 86 })
        .toBuffer();
      this.images.set(key, hit);
      if (this.images.size > MAX_IMAGES) this.images.delete(this.images.keys().next().value!);
    }
    return hit;
  }
}
