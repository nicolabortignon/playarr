import type { TransitionPlan } from '@playarr/mix';
import { describe, expect, it } from 'vitest';
import { endOfSongLine, NEXT_LEAD_S } from './endOfSong';

const next = { title: 'Teardrop' };
const blend = (aStart: number, style: TransitionPlan['style'] = 'long') => ({ style, aStart });

describe('the end of a song, in the player’s subtitle', () => {
  it('says what comes next from ten seconds before the song ends', () => {
    expect(NEXT_LEAD_S).toBe(10);
    expect(endOfSongLine({ time: 189.9, duration: 200, next })).toBeUndefined();
    expect(endOfSongLine({ time: 190, duration: 200, next })).toBe('Next: Teardrop');
    expect(endOfSongLine({ time: 199.5, duration: 200, next })).toBe('Next: Teardrop');
  });

  it('says nothing when nothing follows, or before the song’s length is known', () => {
    expect(endOfSongLine({ time: 195, duration: 200 })).toBeUndefined();
    expect(endOfSongLine({ time: 0, duration: 0, next })).toBeUndefined();
  });

  it('counts the ten seconds to where Crossfade starts fading', () => {
    expect(endOfSongLine({ time: 183, duration: 200, next, fade: 6 })).toBeUndefined();
    expect(endOfSongLine({ time: 184, duration: 200, next, fade: 6 })).toBe('Next: Teardrop');
  });

  it('with DJ mix blending them, says the mix comes on the next bar through the last bar before it, then that it’s mixing', () => {
    // The blend starts at 3:00 of a 3:20 song; a bar at 124 BPM lasts about 1.9 s.
    const dj = { duration: 200, next, plan: blend(180), ready: true, bar: (4 * 60) / 124 };
    expect(endOfSongLine({ ...dj, time: 169 })).toBeUndefined();
    expect(endOfSongLine({ ...dj, time: 170 })).toBe('Next: Teardrop');
    expect(endOfSongLine({ ...dj, time: 178 })).toBe('Next: Teardrop');
    expect(endOfSongLine({ ...dj, time: 178.2 })).toBe('Mixing into Teardrop on the next bar');
    expect(endOfSongLine({ ...dj, time: 180 })).toBe('Mixing into Teardrop');
    expect(endOfSongLine({ ...dj, time: 186 })).toBe('Mixing into Teardrop');
  });

  it('says a quick mix the same way, and a bar of two seconds when the tempo isn’t known', () => {
    const quick = { duration: 200, next, plan: blend(190, 'quick'), ready: true };
    expect(endOfSongLine({ ...quick, time: 187.9 })).toBe('Next: Teardrop');
    expect(endOfSongLine({ ...quick, time: 188 })).toBe('Mixing into Teardrop on the next bar');
  });

  it('says only what comes next for a plan that won’t blend: not ready, a crossfade, straight on', () => {
    for (const plan of [blend(180), blend(180, 'fade'), blend(180, 'straight')]) {
      const ready = plan.style !== 'long';
      expect(endOfSongLine({ duration: 200, next, plan, ready, time: 179.5 })).toBe('Next: Teardrop');
      expect(endOfSongLine({ duration: 200, next, plan, ready, time: 185 })).toBe('Next: Teardrop');
    }
    // The ten seconds count to where the plan has the song give way.
    expect(endOfSongLine({ duration: 200, next, plan: blend(180, 'fade'), ready: true, time: 169 })).toBeUndefined();
  });
});
