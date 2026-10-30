import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Organizer } from './organizer.ts';
import { CatalogStore } from './store.ts';
import { flacBytes, freshDb, mezzanine, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tempDir();
  cleanup = t.cleanup;
  const put = (rel: string, bytes: Buffer = flacBytes()) => {
    mkdirSync(dirname(join(t.dir, rel)), { recursive: true });
    writeFileSync(join(t.dir, rel), bytes);
  };
  put('misc/a.flac');
  put('misc/b.flac');
  put('misc/cover.jpg', Buffer.from([1, 2, 3]));
  const store = new CatalogStore(freshDb());
  const id = store.addSource('folder', 'Music', { path: t.dir });
  const sync = mezzanine();
  sync.copies = [
    { ...sync.copies[0]!, ref: 'misc/a.flac', path: join(t.dir, 'misc/a.flac'), preferredId: undefined },
    { ...sync.copies[1]!, ref: 'misc/b.flac', path: join(t.dir, 'misc/b.flac'), preferredId: undefined },
  ];
  store.applySync(id, sync);
  return { dir: t.dir, put, store, id, organizer: new Organizer(store) };
}

describe('Organizer', () => {
  it('plans moves for a writable folder', () => {
    const { organizer, id } = setup();
    const plan = organizer.plan(id);
    expect(plan.writable).toBe(true);
    expect(plan.moves.map((m) => [m.from, m.to])).toEqual([
      ['misc/a.flac', 'Massive Attack/Mezzanine/01 Angel.flac'],
      ['misc/b.flac', 'Massive Attack/Mezzanine/02 Risingson.flac'],
    ]);
  });

  it('moves the chosen files, their cover, and removes the emptied folder', async () => {
    const { organizer, id, dir, store } = setup();
    const result = await organizer.apply(id, ['misc/a.flac', 'misc/b.flac']);
    expect(result).toMatchObject({ moved: 2, skipped: [] });
    expect(readdirSync(join(dir, 'Massive Attack/Mezzanine')).sort()).toEqual(['01 Angel.flac', '02 Risingson.flac', 'cover.jpg']);
    expect(existsSync(join(dir, 'misc'))).toBe(false);
    expect(store.load().copies.map((c) => c.path).sort()).toEqual([
      join(dir, 'Massive Attack/Mezzanine/01 Angel.flac'),
      join(dir, 'Massive Attack/Mezzanine/02 Risingson.flac'),
    ]);
  });

  it('moves only what was chosen, and leaves companions when the folder keeps audio', async () => {
    const { organizer, id, dir } = setup();
    await organizer.apply(id, ['misc/a.flac']);
    expect(existsSync(join(dir, 'Massive Attack/Mezzanine/01 Angel.flac'))).toBe(true);
    expect(existsSync(join(dir, 'misc/b.flac'))).toBe(true);
    expect(existsSync(join(dir, 'misc/cover.jpg'))).toBe(true);
  });

  it('ignores files the plan doesn’t propose', async () => {
    const { organizer, id } = setup();
    expect((await organizer.apply(id, ['../../etc/passwd'])).moved).toBe(0);
  });

  it('never overwrites a file that appeared since planning', async () => {
    const { organizer, id, put } = setup();
    put('Massive Attack/Mezzanine/01 Angel.flac', Buffer.from('mine'));
    const result = await organizer.apply(id, ['misc/a.flac']);
    expect(result.moved).toBe(0);
    expect(result.skipped[0]).toMatchObject({ from: 'misc/a.flac', reason: 'A file is already there' });
  });

  it('never moves a file out of the folder through a symlinked folder', async () => {
    const { organizer, id, dir } = setup();
    const outside = tempDir();
    try {
      symlinkSync(outside.dir, join(dir, 'Massive Attack'));
      const result = await organizer.apply(id, ['misc/a.flac']);
      expect(result.moved).toBe(0);
      expect(result.skipped[0]).toMatchObject({ from: 'misc/a.flac', reason: 'Outside the folder' });
      expect(existsSync(join(dir, 'misc/a.flac'))).toBe(true);
      expect(readdirSync(outside.dir)).toEqual([]);
    } finally {
      outside.cleanup();
    }
  });

  it('undoes a batch', async () => {
    const { organizer, id, dir, store } = setup();
    const { batchId } = await organizer.apply(id, ['misc/a.flac', 'misc/b.flac']);
    expect(organizer.plan(id).lastBatch).toMatchObject({ id: batchId, files: 3 });
    const undone = await organizer.undo(id, batchId);
    expect(undone.restored).toBe(3);
    expect(readdirSync(join(dir, 'misc')).sort()).toEqual(['a.flac', 'b.flac', 'cover.jpg']);
    expect(existsSync(join(dir, 'Massive Attack'))).toBe(false);
    expect(store.load().copies.map((c) => c.path).sort()).toEqual([join(dir, 'misc/a.flac'), join(dir, 'misc/b.flac')]);
    expect(organizer.plan(id).lastBatch).toBeUndefined();
  });

  it('undo never overwrites a file that took the old place', async () => {
    const { organizer, id, dir, put } = setup();
    const { batchId } = await organizer.apply(id, ['misc/a.flac', 'misc/b.flac']);
    put('misc/a.flac', Buffer.from('new'));
    const undone = await organizer.undo(id, batchId);
    expect(undone.restored).toBe(2);
    expect(undone.skipped).toEqual([{ from: 'Massive Attack/Mezzanine/01 Angel.flac', to: 'misc/a.flac', reason: 'A file is already there' }]);
    expect(readFileSync(join(dir, 'misc/a.flac'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'Massive Attack/Mezzanine/01 Angel.flac'))).toBe(true);
    expect(organizer.plan(id).lastBatch).toMatchObject({ id: batchId, files: 1 });
  });
});

