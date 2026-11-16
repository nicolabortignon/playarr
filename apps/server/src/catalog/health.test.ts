import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceHealth } from './health.ts';

function setup(probe: (id: number) => Promise<unknown> | undefined, opts: { timeoutMs?: number; recheckMs?: number } = {}) {
  const changes: number[][] = [];
  const health = new SourceHealth({
    probe,
    onChange: (offline) => changes.push([...offline].sort()),
    log: { info: () => {}, warn: () => {} },
    ...opts,
  });
  return { health, changes };
}

describe('SourceHealth', () => {
  afterEach(() => vi.useRealTimers());

  it('finds a source offline only when the source itself doesn’t answer', async () => {
    const answers = new Map([
      [1, true],
      [2, false],
    ]);
    const { health, changes } = setup((id) => (answers.get(id) ? Promise.resolve() : Promise.reject(new Error('Host is down'))));
    expect(await health.check(1)).toBe(false);
    expect(await health.check(2)).toBe(true);
    expect(health.isOffline(2)).toBe(true);
    expect([...health.offline()]).toEqual([2]);
    expect(changes).toEqual([[2]]);
    // Asked again, still away: nothing new to say.
    expect(await health.check(2)).toBe(true);
    expect(changes).toEqual([[2]]);
  });

  it('asks a source once at a time', async () => {
    let asked = 0;
    let answer!: () => void;
    const { health } = setup(() => {
      asked++;
      return new Promise<void>((resolve) => (answer = resolve));
    });
    const both = Promise.all([health.check(1), health.check(1)]);
    answer();
    expect(await both).toEqual([false, false]);
    expect(asked).toBe(1);
  });

  it('counts a source that takes too long to answer as offline', async () => {
    const { health } = setup(() => new Promise(() => {}), { timeoutMs: 10 });
    expect(await health.check(3)).toBe(true);
  });

  it('counts a source with nothing to ask as answering', async () => {
    const { health, changes } = setup(() => undefined);
    expect(await health.check(4)).toBe(false);
    expect(changes).toEqual([]);
  });

  it('has a source back once one of its files is read, or it answers when asked again', async () => {
    vi.useFakeTimers();
    let up = false;
    const { health, changes } = setup(() => (up ? Promise.resolve() : Promise.reject(new Error('ENOENT'))), { recheckMs: 60_000 });
    await health.check(1);
    await health.check(2);
    health.reached(1);
    expect(changes).toEqual([[1], [1, 2], [2]]);

    health.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(health.isOffline(2)).toBe(true);
    up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(health.isOffline(2)).toBe(false);
    expect(changes.at(-1)).toEqual([]);
    health.stop();
  });
});
