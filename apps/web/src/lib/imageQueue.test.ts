import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LOADING, NEAR_SCREEN, ON_SCREEN, queueImage, resetImageQueue } from './imageQueue';

afterEach(() => resetImageQueue());

describe('queueImage', () => {
  it('gives the first turns to on-screen images among those asking together', async () => {
    const started: string[] = [];
    for (let i = 0; i < MAX_LOADING; i++) queueImage(NEAR_SCREEN, () => started.push(`near${i}`));
    queueImage(ON_SCREEN, () => started.push('visible'));
    await Promise.resolve();
    expect(started[0]).toBe('visible');
  });

  it('loads a few at a time, on-screen images first, and gives turns to waiting ones as loads finish', async () => {
    const started: string[] = [];
    const done: Record<string, () => void> = {};
    const want = (name: string, priority: number) =>
      queueImage(priority, (finish) => {
        started.push(name);
        done[name] = finish;
      });
    for (let i = 0; i < MAX_LOADING; i++) want(`first${i}`, NEAR_SCREEN);
    await Promise.resolve();
    want('near', NEAR_SCREEN);
    const cancelGone = want('gone', ON_SCREEN);
    want('visible', ON_SCREEN);
    await Promise.resolve();
    expect(started).toHaveLength(MAX_LOADING);
    cancelGone(); // scrolled away before its turn
    done.first0!();
    expect(started.at(-1)).toBe('visible'); // on screen beats near, whatever the order they asked in
    done.first1!();
    done.first1!(); // a second report changes nothing
    expect(started.slice(MAX_LOADING)).toEqual(['visible', 'near']);
  });
});
