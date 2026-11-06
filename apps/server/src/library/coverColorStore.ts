import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { FileRecord } from '../catalog/build.ts';
import { isAllowedRemote } from '../discover/art.ts';
import { readCoverColors, type CoverColors } from './coverColors.ts';

/** Goes up when covers would give other colors (coverColors.ts changed): those read before are read again. */
export const COVER_COLORS_VERSION = 1;
/** A cover found to have no picture is looked at again after a day: its file may have one by then. */
const RETRY_MS = 86_400_000;
/** Covers on this server's disks or Lidarr's read at once by the background fill. */
const AT_ONCE = 2;
/**
 * Covers of one source failing in a row after which a fill leaves the rest of them for the next (a NAS that's away, the
 * Cover Art Archive refusing). Remote covers count as one source.
 */
const GIVE_UP_AFTER = 5;
/** Images from the art routes waiting to be read; past this, the background fill gets to them. */
const MAX_WAITING = 16;

/**
 * An album cover whose colors can be read: Lidarr's, a folder file's picture, or the MusicBrainz cover (Cover Art
 * Archive) of an album without either; `key` identifies the image.
 */
export type CoverImage =
  | { key: string; kind: 'lidarr'; albumId: number; version: string }
  | { key: string; kind: 'copy'; file: FileRecord; embedded: boolean }
  | { key: string; kind: 'remote'; url: string };

/**
 * Reads a cover for its colors: the image; null when there's no picture (looked at again after a day); undefined when
 * it can't be had cheaply now (left for a later fill). Throws when the cover's source can't be reached.
 */
export type CoverReader = (image: CoverImage) => Promise<Buffer | null | undefined>;

/** What identifies Lidarr's cover of an album: the album and Lidarr's version of the picture (`?v=`, "0" without). */
export const lidarrCoverKey = (albumId: number, version: string) => `album/${albumId}/${version}`;
/** What identifies a folder file's picture: the file and its size, which re-tagging changes (the art cache keys it so too). */
export const copyCoverKey = (fileId: number, size: number, embedded: boolean) => `copy/${fileId}/${size}${embedded ? '/embedded' : ''}`;
/** What identifies a remote cover: its URL (as `new URL()` writes it, like the art route). */
export const remoteCoverKey = (url: string) => `remote/${url}`;

/**
 * The image behind a library album's cover URL (catalog/build.ts): Lidarr's cover (`/art/album/:id/cover?v=`), a folder
 * file's picture (`/art/copy/:id`, `?embedded=1`), or the MusicBrainz cover of an album without either
 * (`/art/remote?url=`, only from hosts the art route fetches from). Only for library albums: Discover's and search's
 * remote covers never come here. undefined for a file `files` doesn't have.
 */
export function coverImage(url: string | undefined, files: ReadonlyMap<number, FileRecord>): CoverImage | undefined {
  const lidarr = url?.match(/^\/art\/album\/(\d+)\/cover(?:\?v=(\d+))?$/);
  if (lidarr) {
    // As the art route reads `v`: anything but a number of up to 20 digits is version 0.
    const version = /^\d{1,20}$/.test(lidarr[2] ?? '') ? lidarr[2]! : '0';
    const albumId = Number(lidarr[1]);
    return { key: lidarrCoverKey(albumId, version), kind: 'lidarr', albumId, version };
  }
  const remote = url?.match(/^\/art\/remote\?url=([^&]+)$/);
  if (remote) {
    let target: URL;
    try {
      target = new URL(decodeURIComponent(remote[1]!));
    } catch {
      return undefined;
    }
    return isAllowedRemote(target) ? { key: remoteCoverKey(target.href), kind: 'remote', url: target.href } : undefined;
  }
  const copy = url?.match(/^\/art\/copy\/(\d+)(\?embedded=1)?$/);
  const file = copy ? files.get(Number(copy[1])) : undefined;
  if (!copy || !file) return undefined;
  const embedded = copy[2] !== undefined;
  return { key: copyCoverKey(file.id, file.size, embedded), kind: 'copy', file, embedded };
}

interface Row {
  key: string;
  color: string | null;
  accent: string | null;
  version: number;
  read_at: string;
}

interface Known {
  /** Absent when the cover had no picture, or one that couldn't be decoded. */
  colors?: CoverColors;
  version: number;
  readAt: number;
}

/**
 * Album covers' colors (`coverColor` and `coverAccent` of albums and songs), read once per image and kept in the
 * `cover_colors` table: in the background after each library refresh (`fill`), and from images the art routes have in
 * hand anyway (`offer`). Nothing ever waits for them: a cover not read yet just has no colors.
 */
export class CoverColorStore {
  private readonly known = new Map<string, Known>();
  private readonly listeners: ((key: string, colors: CoverColors | undefined) => void)[] = [];
  private readonly upsert: StatementSync;
  /** Covers being read, so a fill and an offer don't both read one. */
  private readonly reading = new Set<string>();
  /** Images the art routes offered, read one after another. */
  private readonly waiting = new Map<string, Buffer>();
  private offered: Promise<void> = Promise.resolve();
  private filling = false;
  /** A fill asked for while one ran: it follows, with the newest list. */
  private nextFill: { images: CoverImage[]; read: CoverReader } | null = null;

  constructor(
    db: DatabaseSync,
    private readonly deps: { log?: { info: (msg: string) => void }; now?: () => number } = {},
  ) {
    for (const r of db.prepare('SELECT key, color, accent, version, read_at FROM cover_colors').all() as unknown as Row[]) {
      const colors = r.color ? { color: r.color, ...(r.accent ? { accent: r.accent } : {}) } : undefined;
      this.known.set(r.key, { colors, version: r.version, readAt: Date.parse(r.read_at) });
    }
    this.upsert = db.prepare(
      `INSERT INTO cover_colors (key, color, accent, version, read_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET color = excluded.color, accent = excluded.accent, version = excluded.version, read_at = excluded.read_at`,
    );
  }

  /** The colors of the cover image with this key, once read (an older version's until it's read again). */
  get(key: string): CoverColors | undefined {
    return this.known.get(key)?.colors;
  }

  /** Called with each cover read from now on whose colors changed (undefined: it turned out to have none). */
  onRead(listener: (key: string, colors: CoverColors | undefined) => void) {
    this.listeners.push(listener);
  }

  /**
   * Read the colors of an image the art routes have in hand anyway, after the images offered before it, unless they're
   * known. The routes don't wait for it; the promise is for tests.
   */
  offer(key: string, image: Buffer): Promise<void> {
    if (!this.wanted(key) || this.waiting.has(key) || this.waiting.size >= MAX_WAITING) return this.offered;
    this.waiting.set(key, image);
    // One at a time: images are offered while someone browses, when the art routes have the most to do.
    this.offered = this.offered
      .then(async () => {
        const body = this.waiting.get(key);
        this.waiting.delete(key);
        if (body && this.wanted(key)) await this.read(key, async () => body);
      })
      .catch(() => {});
    return this.offered;
  }

  /**
   * Read the colors of the covers that have none (nor an older version's, nor no picture a day ago), in the order given
   * (newest albums first), in the background: two at a time, and remote covers one at a time beside them (the Cover
   * Art Archive is someone else's service). Runs after each library refresh; what's read is kept, so after a restart it
   * goes on where it stopped. A fill asked for while one runs follows it.
   */
  async fill(images: CoverImage[], read: CoverReader): Promise<void> {
    if (this.filling) {
      this.nextFill = { images, read };
      return;
    }
    this.filling = true;
    try {
      const todo = images.filter((image) => this.due(image.key));
      const started = Date.now();
      const failures = new Map<string, number>();
      const sourceOf = (image: CoverImage) => (image.kind === 'copy' ? `source ${image.file.sourceId}` : image.kind);
      let done = 0;
      const lane = (covers: CoverImage[], workers: number) => {
        let next = 0;
        const worker = async () => {
          while (next < covers.length) {
            const image = covers[next++]!;
            const source = sourceOf(image);
            if ((failures.get(source) ?? 0) >= GIVE_UP_AFTER || !this.due(image.key)) continue;
            try {
              if (await this.read(image.key, () => read(image))) done++;
              failures.set(source, 0);
            } catch {
              failures.set(source, (failures.get(source) ?? 0) + 1);
            }
          }
        };
        return Array.from({ length: workers }, worker);
      };
      await Promise.all([
        ...lane(todo.filter((image) => image.kind !== 'remote'), AT_ONCE),
        ...lane(todo.filter((image) => image.kind === 'remote'), 1),
      ]);
      if (done) this.deps.log?.info(`Cover colors: ${done} of ${todo.length} covers read in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } finally {
      this.filling = false;
      const queued = this.nextFill;
      this.nextFill = null;
      if (queued) void this.fill(queued.images, queued.read);
    }
  }

  /** An image in hand is worth reading when its cover has no colors yet, or only an older version's. */
  private wanted(key: string): boolean {
    const known = this.known.get(key);
    return !this.reading.has(key) && (!known?.colors || known.version < COVER_COLORS_VERSION);
  }

  /** The fill reads a cover never read, read by an older version, or found without a picture a day ago. */
  private due(key: string): boolean {
    const known = this.known.get(key);
    if (this.reading.has(key)) return false;
    if (!known || known.version < COVER_COLORS_VERSION) return true;
    return !known.colors && this.now() - known.readAt >= RETRY_MS;
  }

  /**
   * Read one cover and keep what it gave: true once it's read (colors, or none to give), false when its image can't be
   * had now. Throws only what `image` throws.
   */
  private async read(key: string, image: () => Promise<Buffer | null | undefined>): Promise<boolean> {
    this.reading.add(key);
    try {
      const body = await image();
      if (body === undefined) return false;
      this.save(key, body ? await readCoverColors(body).catch(() => undefined) : undefined);
      return true;
    } finally {
      this.reading.delete(key);
    }
  }

  private save(key: string, colors: CoverColors | undefined) {
    const readAt = this.now();
    try {
      this.upsert.run(key, colors?.color ?? null, colors?.accent ?? null, COVER_COLORS_VERSION, new Date(readAt).toISOString());
    } catch {
      return; // the database closed (the server is stopping): read again next time
    }
    const before = this.known.get(key)?.colors;
    this.known.set(key, { ...(colors ? { colors } : {}), version: COVER_COLORS_VERSION, readAt });
    if (before?.color === colors?.color && before?.accent === colors?.accent) return;
    for (const listener of this.listeners) listener(key, colors);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
