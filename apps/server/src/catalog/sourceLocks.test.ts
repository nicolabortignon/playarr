import { describe, expect, it } from 'vitest';
import { SourceLocks } from './sourceLocks.ts';

/** Work that runs until `finish()`, saying when it started. */
function held() {
  let finish!: () => void;
  let started = false;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return {
    work: () => {
      started = true;
      return done;
    },
    finish,
    started: () => started,
  };
}

describe('SourceLocks', () => {
  it('runs one source’s work one at a time, in order, and other sources’ beside it', async () => {
    const locks = new SourceLocks();
    const sync = held();
    const move = held();
    const other = held();
    const syncing = locks.run(1, sync.work);
    const moving = locks.run(1, move.work);
    void locks.run(2, other.work);
    await Promise.resolve();
    expect([sync.started(), move.started(), other.started()]).toEqual([true, false, true]);
    sync.finish();
    await syncing;
    await Promise.resolve();
    expect(move.started()).toBe(true);
    move.finish();
    other.finish();
    await moving;
  });

  it('lets the next work go on after one fails, and hands the failure to its own caller', async () => {
    const locks = new SourceLocks();
    const failed = locks.run(1, async () => {
      throw new Error('Folder not found');
    });
    const next = locks.run(1, async () => 'moved');
    await expect(failed).rejects.toThrow('Folder not found');
    await expect(next).resolves.toBe('moved');
  });
});
