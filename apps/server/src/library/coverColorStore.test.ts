import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FileRecord } from '../catalog/build.ts';
import { FLAC, freshDb } from '../catalog/testFixtures.ts';
import { COVER_COLORS_VERSION, CoverColorStore, coverImage, type CoverImage } from './coverColorStore.ts';

const png = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer();
const BLUE = { color: '#0000ff', accent: '#6e6ef7' };

const file = (id: number, size = 1000, sourceId = 2): FileRecord => ({ id, sourceId, path: `/music/${id}.flac`, size, format: FLAC });
const lidarr = (albumId: number): CoverImage => ({ key: `album/${albumId}/0`, kind: 'lidarr', albumId, version: '0' });
const copy = (id: number, sourceId: number): CoverImage => ({ key: `copy/${id}/1000`, kind: 'copy', file: file(id, 1000, sourceId), embedded: false });

describe('coverImage', () => {
  it('knows Lidarr’s covers by album and version, folder pictures by file and size', () => {
    const files = new Map([[9000, file(9000, 4321)]]);
    expect(coverImage('/art/album/70/cover?v=638', files)).toEqual({ key: 'album/70/638', kind: 'lidarr', albumId: 70, version: '638' });
    expect(coverImage('/art/album/70/cover', files)?.key).toBe('album/70/0');
    expect(coverImage('/art/copy/9000', files)).toEqual({ key: 'copy/9000/4321', kind: 'copy', file: files.get(9000), embedded: false });
    expect(coverImage('/art/copy/9000?embedded=1', files)?.key).toBe('copy/9000/4321/embedded');
  });

  it('has nothing to read for remote covers and files it doesn’t know', () => {
    const files = new Map([[9000, file(9000)]]);
    expect(coverImage('/art/remote?url=https%3A%2F%2Fcoverartarchive.org%2Frelease-group%2Fx%2Ffront-500', files)).toBeUndefined();
    expect(coverImage('/art/copy/9001', files)).toBeUndefined();
    expect(coverImage(undefined, files)).toBeUndefined();
  });
});

describe('CoverColorStore', () => {
  it('reads an image the art routes offer, tells who listens, and keeps it for the next start', async () => {
    const db = freshDb();
    const colors = new CoverColorStore(db);
    const heard = vi.fn();
    colors.onRead(heard);
    await colors.offer('album/70/1', await png('#0000ff'));
    expect(colors.get('album/70/1')).toEqual(BLUE);
    expect(heard).toHaveBeenCalledWith('album/70/1', BLUE);
    expect(new CoverColorStore(db).get('album/70/1')).toEqual(BLUE);
  });

  it('leaves an offered image alone when its cover’s colors are known', async () => {
    const colors = new CoverColorStore(freshDb());
    const heard = vi.fn();
    colors.onRead(heard);
    await colors.offer('album/70/1', await png('#0000ff'));
    await colors.offer('album/70/1', await png('#ff0000'));
    expect(colors.get('album/70/1')).toEqual(BLUE);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('fills in the covers without colors, and after a restart reads none of those it has', async () => {
    const db = freshDb();
    const colors = new CoverColorStore(db);
    await colors.offer('album/1/0', await png('#0000ff'));
    const read = vi.fn(async () => png('#ff0000'));
    await colors.fill([lidarr(1), lidarr(2)], read);
    expect(read.mock.calls).toEqual([[lidarr(2)]]);
    expect(colors.get('album/2/0')).toEqual({ color: '#ff0000', accent: '#f42a2a' });
    await new CoverColorStore(db).fill([lidarr(1), lidarr(2)], read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('looks again a day later at a cover without a picture, and at every fill at one it couldn’t have', async () => {
    let now = Date.parse('2026-11-06T12:00:00Z');
    const colors = new CoverColorStore(freshDb(), { now: () => now });
    const none = vi.fn(async () => null);
    await colors.fill([lidarr(1)], none);
    await colors.fill([lidarr(1)], none);
    expect(none).toHaveBeenCalledTimes(1);
    expect(colors.get('album/1/0')).toBeUndefined();
    now += 86_400_000;
    await colors.fill([lidarr(1)], none);
    expect(none).toHaveBeenCalledTimes(2);

    const notNow = vi.fn(async () => undefined);
    await colors.fill([lidarr(2)], notNow);
    await colors.fill([lidarr(2)], notNow);
    expect(notNow).toHaveBeenCalledTimes(2);
  });

  it('takes an offered image for a cover found without a picture', async () => {
    const colors = new CoverColorStore(freshDb());
    await colors.fill([lidarr(1)], async () => null);
    await colors.offer('album/1/0', await png('#0000ff'));
    expect(colors.get('album/1/0')).toEqual(BLUE);
  });

  it('leaves the rest of a source that keeps failing for the next fill, and reads the others’', async () => {
    const colors = new CoverColorStore(freshDb());
    const away = Array.from({ length: 20 }, (_, i) => copy(100 + i, 3));
    const blue = await png('#0000ff');
    const read = vi.fn(async (image: CoverImage) => {
      if (image.kind === 'copy') throw new Error('The file can’t be reached');
      return blue;
    });
    await colors.fill([...away, lidarr(1)], read);
    expect(read.mock.calls.filter(([image]) => image.kind === 'copy').length).toBeLessThan(away.length);
    expect(colors.get('album/1/0')).toEqual(BLUE);
    expect(colors.get(away[0]!.key)).toBeUndefined();
  });

  it('reads again the covers an older version read, keeping their colors meanwhile', async () => {
    const db = freshDb();
    db.prepare('INSERT INTO cover_colors (key, color, accent, version, read_at) VALUES (?, ?, ?, ?, ?)').run(
      'album/1/0',
      '#111111',
      null,
      COVER_COLORS_VERSION - 1,
      '2026-01-01T00:00:00.000Z',
    );
    const colors = new CoverColorStore(db);
    expect(colors.get('album/1/0')).toEqual({ color: '#111111' });
    await colors.fill([lidarr(1)], async () => png('#0000ff'));
    expect(colors.get('album/1/0')).toEqual(BLUE);
  });

  it('runs one fill at a time, the newest asked for next', async () => {
    const colors = new CoverColorStore(freshDb());
    let release = () => {};
    const blue = await png('#0000ff');
    const read = vi.fn(async (image: CoverImage) => {
      if (image.key === 'album/1/0') await new Promise<void>((resolve) => (release = resolve));
      return blue;
    });
    const first = colors.fill([lidarr(1)], read);
    await colors.fill([lidarr(2)], read);
    await colors.fill([lidarr(3)], read);
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await first;
    await vi.waitFor(() => expect(colors.get('album/3/0')).toEqual(BLUE));
    expect(colors.get('album/2/0')).toBeUndefined();
  });
});
