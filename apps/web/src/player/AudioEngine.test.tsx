import type { TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { AudioEngine } from './AudioEngine';
import { playTracker } from './playTracker';
import { useOffline } from './offline';
import { useSleep } from './sleep';
import { currentTrack, useClock, usePlayer } from './store';
import { useTransition } from './transitions';

vi.mock('./loadAhead', () => ({ useLoadAhead: () => {} }));
vi.mock('./playTracker', () => ({ playTracker: { start: vi.fn(), finish: vi.fn(), tick: vi.fn(), pause: vi.fn() } }));
// The tests say which transition is ready, instead of the server.
vi.mock('./transitions', async (importOriginal) => ({ ...(await importOriginal<typeof import('./transitions')>()), useUpcomingTransition: () => {} }));

/** jsdom has no audio: a stand-in whose clock the test moves by hand. */
interface Fake {
  paused: boolean;
  time: number;
  duration: number;
  ended: boolean;
  volume: number;
}
const fakes = new WeakMap<HTMLMediaElement, Fake>();
const fake = (el: HTMLMediaElement) => {
  if (!fakes.has(el)) fakes.set(el, { paused: true, time: 0, duration: 200, ended: false, volume: 1 });
  return fakes.get(el)!;
};
const blocked = new Set<HTMLMediaElement>();

beforeEach(() => {
  Object.defineProperties(HTMLMediaElement.prototype, {
    paused: { configurable: true, get: function (this: HTMLMediaElement) { return fake(this).paused; } },
    ended: { configurable: true, get: function (this: HTMLMediaElement) { return fake(this).ended; } },
    duration: { configurable: true, get: function (this: HTMLMediaElement) { return this.getAttribute('src') ? fake(this).duration : NaN; } },
    readyState: { configurable: true, get: function (this: HTMLMediaElement) { return this.getAttribute('src') ? 4 : 0; } },
    currentTime: {
      configurable: true,
      get: function (this: HTMLMediaElement) { return fake(this).time; },
      set: function (this: HTMLMediaElement, v: number) { fake(this).time = v; },
    },
    volume: {
      configurable: true,
      get: function (this: HTMLMediaElement) { return fake(this).volume; },
      set: function (this: HTMLMediaElement, v: number) { fake(this).volume = v; },
    },
  });
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (blocked.has(this)) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    const f = fake(this);
    f.paused = false;
    f.ended = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    const f = fake(this);
    if (f.paused) return;
    f.paused = true;
    this.dispatchEvent(new Event('pause'));
  };
  HTMLMediaElement.prototype.load = function () {};
  vi.spyOn(api, 'levels').mockResolvedValue({});
  vi.spyOn(api, 'radio').mockResolvedValue([]);
  usePrefs.setState({ transitions: 'off', crossfade: 0, levelVolume: true, autoplay: false });
  usePlayer.setState({ repeat: 'off', volume: 1, muted: false });
});

afterEach(() => {
  cleanup();
  blocked.clear();
  vi.clearAllMocks();
  useTransition.setState({ fromFileId: null, toFileId: null, result: null, ready: undefined });
  useSleep.getState().cancel();
});

const song = (id: number, albumId = id) =>
  ({ id, fileId: id, recordingId: `r${id}`, albumId, discNumber: 1, trackNumber: 1, duration: 200, title: `Song ${id}`, streamUrl: `/stream/${id}` }) as Track;

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
/** Long enough for the short overlap where two files join. */
const overlap = () => act(() => new Promise((r) => setTimeout(r, 40)));

async function at(deck: HTMLAudioElement, time: number) {
  fake(deck).time = time;
  await act(async () => {
    deck.dispatchEvent(new Event('timeupdate'));
  });
  await settle();
}

async function end(deck: HTMLAudioElement) {
  Object.assign(fake(deck), { ended: true, paused: true });
  await act(async () => {
    deck.dispatchEvent(new Event('ended'));
  });
  await settle();
}

async function start(tracks: Track[]) {
  usePlayer.getState().playTracks(tracks, 0, { shuffle: false });
  const { container } = render(<AudioEngine />);
  await settle();
  return [...container.querySelectorAll('audio')] as [HTMLAudioElement, HTMLAudioElement, HTMLAudioElement];
}

const src = (deck: HTMLAudioElement) => deck.getAttribute('src');
const now = () => currentTrack(usePlayer.getState())?.fileId;
const clock = () => useClock.getState().time;

/** A long blend: from 170 s into song 1, 24 s of transition into song 2 from 8 s, which resumes at 32 s. */
const plan = (over: Partial<TransitionPlan> = {}) =>
  ({
    style: 'long',
    aStart: 170,
    bStart: 8,
    length: 24,
    bResume: 32,
    switchAt: 12,
    bRate: [{ at: 0, value: 1 }],
    aGain: [{ at: 0, value: 1 }, { at: 24, value: 0 }],
    bGain: [{ at: 0, value: 0 }, { at: 24, value: 1 }],
    ...over,
  }) as Partial<TransitionPlan> as TransitionPlan;

const TRANSITION = '/transitions/abc.flac';

/** The server has rendered the transition from `from` into `to` (file ids). */
function transitionReady(from: number, to: number, extra: { plan?: TransitionPlan; continuationUrl?: string } = {}) {
  const result = { status: 'ready' as const, plan: extra.plan ?? plan(), url: TRANSITION, ...(extra.continuationUrl ? { continuationUrl: extra.continuationUrl } : {}) };
  useTransition.setState({ fromFileId: from, toFileId: to, result, ready: { ...result, fromFileId: from, toFileId: to } });
}

/** Song 1 played into the transition, `t` seconds in. */
async function intoTransition(t: number, tracks = [song(1), song(2), song(3)]) {
  const decks = await start(tracks);
  const [a, , bridge] = decks;
  await at(a, 145);
  await at(a, 169.99);
  await overlap();
  if (t > 0) await at(bridge, t);
  return decks;
}

describe('AudioEngine', () => {
  it('starts the next song on the other player right as one ends, without loading it again', async () => {
    const [a, b] = await start([song(1), song(2), song(3)]);
    expect(src(a)).toBe('/stream/1');
    expect(fake(a).paused).toBe(false);
    await at(a, 150);
    expect(src(b)).toBeNull(); // not yet
    await at(a, 175);
    expect(src(b)).toBe('/stream/2'); // the next song loads ahead
    await at(a, 199.99);
    expect(now()).toBe(2);
    expect(fake(b).paused).toBe(false);
    expect(src(a)).toBe('/stream/1'); // left to finish its last moment
    expect(playTracker.finish).toHaveBeenCalledWith('ended');
    await end(a);
    expect(now()).toBe(2); // the first player ending doesn't skip a song
    await at(b, 175);
    expect(src(a)).toBe('/stream/3'); // and it loads the one after
  });

  it('starts the loaded song as soon as one ends, when the timer came too late', async () => {
    const [a, b] = await start([song(1), song(2)]);
    await at(a, 185); // loaded, not yet time to start it
    expect(src(b)).toBe('/stream/2');
    await end(a);
    expect(now()).toBe(2);
    expect(fake(b).paused).toBe(false);
  });

  it('falls back to one player when the phone won’t let the other start on its own', async () => {
    const [a, b] = await start([song(1), song(2)]);
    blocked.add(b);
    await at(a, 199.99);
    expect(now()).toBe(1);
    await end(a);
    expect(now()).toBe(2);
    expect(src(a)).toBe('/stream/2');
    expect(fake(a).paused).toBe(false);
    expect(usePlayer.getState().playing).toBe(true);
  });

  it('crossfades between songs of different albums, the volume following the music', async () => {
    usePrefs.setState({ transitions: 'crossfade', crossfade: 6 });
    const [a, b] = await start([song(1), song(2)]);
    await at(a, 193.99);
    expect(now()).toBe(2);
    expect(fake(b).volume).toBeLessThan(0.05);
    fake(a).time = 197;
    await at(b, 3);
    expect(fake(b).volume).toBeCloseTo(Math.SQRT1_2, 1);
    expect(fake(a).volume).toBeCloseTo(Math.SQRT1_2, 1);
    await at(b, 6.1);
    expect(fake(a).paused).toBe(true);
    expect(fake(b).volume).toBe(1);
  });

  it('plays DJ mix without a gap, not as a crossfade, for now', async () => {
    usePrefs.setState({ transitions: 'dj', crossfade: 6 });
    const [a] = await start([song(1), song(2)]);
    await at(a, 193.99);
    expect(now()).toBe(1);
    await at(a, 199.99);
    expect(now()).toBe(2);
  });

  it('never fades between songs of one album played in order', async () => {
    usePrefs.setState({ transitions: 'crossfade', crossfade: 6 });
    const first = { ...song(1, 9), trackNumber: 1 };
    const second = { ...song(2, 9), trackNumber: 2 };
    const [a] = await start([first, second]);
    await at(a, 193.99);
    expect(now()).toBe(1);
    await at(a, 199.99);
    expect(now()).toBe(2);
  });

  it('skips to a song already loaded, and back, by switching players', async () => {
    const [a, b] = await start([song(1), song(2)]);
    await at(a, 175);
    await act(async () => usePlayer.getState().next());
    await settle();
    expect(fake(b).paused).toBe(false);
    expect(fake(a).paused).toBe(true);
    await act(async () => usePlayer.getState().prev(1));
    await settle();
    expect(now()).toBe(1);
    expect(fake(a).paused).toBe(false);
    expect(fake(a).time).toBe(0);
    expect(fake(b).paused).toBe(true);
  });

  it('repeats one song on the same player', async () => {
    usePlayer.setState({ repeat: 'one' });
    const [a, b] = await start([song(1), song(2)]);
    await at(a, 199.99);
    expect(src(b)).toBeNull();
    await end(a);
    expect(now()).toBe(1);
    expect(fake(a).time).toBe(0);
    expect(fake(a).paused).toBe(false);
  });

  it('stops at the end of the song for the sleep timer, ready on the next one', async () => {
    const [a, b] = await start([song(1), song(2)]);
    useSleep.getState().sleepAtEndOfSong();
    await at(a, 199.99);
    expect(now()).toBe(1); // nothing started early
    expect(src(b)).toBeNull();
    await end(a);
    expect(now()).toBe(2);
    expect(usePlayer.getState().playing).toBe(false);
    expect(fake(a).paused).toBe(true);
    expect(useSleep.getState().endOfSong).toBe(false);
  });

  it('offline, skips to the next song on this device when one can’t load', async () => {
    const [a] = await start([song(1), song(2), song(3)]);
    useOffline.setState({ songs: { 3: { url: '/stream/3', bytes: 1, usedAt: 0 } } });
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await act(async () => {
      a.dispatchEvent(new Event('error'));
    });
    await settle();
    expect(now()).toBe(3);
    online.mockRestore();
    useOffline.setState({ songs: {} });
  });

  it('turns loud songs down', async () => {
    vi.spyOn(api, 'levels').mockResolvedValue({ r41: { track: -6 } });
    const [a] = await start([song(41), song(42)]);
    expect(fake(a).volume).toBeCloseTo(10 ** (-6 / 20), 2);
    usePrefs.getState().setLevelVolume(false);
    await settle();
    expect(fake(a).volume).toBe(1);
  });

  describe('DJ transitions', () => {
    it('plays the transition file from the mix point, then the next song from where the transition ends', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await start([song(1), song(2), song(3)]);
      await at(a, 120);
      expect(src(bridge)).toBeNull(); // not yet
      await at(a, 145);
      // Both load ahead: the transition, and the next song where the transition leaves it.
      expect(src(bridge)).toBe(TRANSITION);
      expect(src(b)).toBe('/stream/2');
      expect(fake(b).time).toBe(32);
      expect(fake(b).paused).toBe(true);
      await at(a, 169.99);
      expect(fake(bridge).paused).toBe(false);
      expect(fake(bridge).time).toBe(0);
      await overlap();
      expect(fake(a).paused).toBe(true);
      expect(usePlayer.getState().playing).toBe(true);
      await at(bridge, 6);
      expect(now()).toBe(1);
      expect(clock()).toBe(176); // the first song's own time
      await at(bridge, 12.1);
      expect(now()).toBe(2);
      expect(clock()).toBeCloseTo(20.1, 6); // the next song's, as heard in the transition
      expect(fake(b).paused).toBe(true);
      await at(bridge, 23.99);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(32);
      await overlap();
      expect(fake(bridge).paused).toBe(true);
      await at(b, 40);
      expect(clock()).toBe(40);
      expect(now()).toBe(2);
      await at(b, 175);
      expect(src(a)).toBe('/stream/3'); // and on as usual
    });

    it('shows the lock screen the next song once, at the switch, and counts each song once', async () => {
      const titles: string[] = [];
      Object.defineProperty(navigator, 'mediaSession', {
        configurable: true,
        value: {
          setActionHandler: () => {},
          setPositionState: () => {},
          playbackState: 'none',
          get metadata() {
            return null;
          },
          set metadata(m: { title: string } | null) {
            if (m) titles.push(m.title);
          },
        },
      });
      vi.stubGlobal(
        'MediaMetadata',
        class {
          constructor(init: object) {
            Object.assign(this, init);
          }
        },
      );
      try {
        transitionReady(1, 2);
        const [a, b, bridge] = await start([song(1), song(2), song(3)]);
        vi.mocked(playTracker.start).mockClear();
        vi.mocked(playTracker.finish).mockClear();
        await at(a, 145);
        await at(a, 169.99);
        await overlap();
        await at(bridge, 11.9);
        expect(titles).toEqual(['Song 1']);
        expect(playTracker.tick).toHaveBeenLastCalledWith(181.9);
        await at(bridge, 12.5);
        await at(bridge, 13);
        await at(bridge, 23.99);
        await overlap();
        await at(b, 33);
        expect(titles).toEqual(['Song 1', 'Song 2']);
        // The first song ended at the switch; the second counts from there, through the transition.
        expect(vi.mocked(playTracker.finish).mock.calls).toEqual([['ended']]);
        expect(vi.mocked(playTracker.start).mock.calls.map(([t]) => t.fileId)).toEqual([2]);
        expect(playTracker.tick).toHaveBeenCalledWith(21);
        expect(playTracker.tick).toHaveBeenLastCalledWith(33);
      } finally {
        delete (navigator as { mediaSession?: unknown }).mediaSession;
        vi.unstubAllGlobals();
      }
    });

    it('goes on with the next song’s remainder file from its start, shown at the song’s own time', async () => {
      transitionReady(1, 2, { continuationUrl: '/transitions/abc-rest.flac' });
      const [a, b, bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      expect(src(b)).toBe('/transitions/abc-rest.flac');
      expect(fake(b).time).toBe(0);
      await at(a, 169.99);
      await overlap();
      await at(bridge, 12.1);
      await at(bridge, 23.99);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(0);
      await at(b, 10);
      expect(clock()).toBe(42);
      expect(playTracker.tick).toHaveBeenLastCalledWith(42);
      // Back before the remainder starts: the song's own file.
      await act(async () => useClock.getState().seek(10));
      await settle();
      expect(src(b)).toBe('/stream/2');
      b.dispatchEvent(new Event('loadedmetadata'));
      expect(fake(b).time).toBe(10);
      expect(fake(b).paused).toBe(false);
    });

    it('skips into the next song where the transition had it', async () => {
      // The next song starts 10% fast in the transition: 6 s in, it's 6.6 s further.
      transitionReady(1, 2, { plan: plan({ bRate: [{ at: 0, value: 1.1 }], bResume: 34.4 }) });
      const [a, b, bridge] = await intoTransition(6);
      await act(async () => usePlayer.getState().next());
      await settle();
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBeCloseTo(14.6, 6);
      expect(fake(bridge).paused).toBe(true);
      expect(fake(a).paused).toBe(true);
      expect(usePlayer.getState().playing).toBe(true);
    });

    it('seeks within the transition while the seek stays inside it', async () => {
      transitionReady(1, 2);
      const [, , bridge] = await intoTransition(4);
      await act(async () => useClock.getState().seek(175)); // the first song's time, shown until the switch
      expect(fake(bridge).time).toBe(5);
      await at(bridge, 14);
      expect(now()).toBe(2);
      await act(async () => useClock.getState().seek(25)); // the next song's time now
      expect(fake(bridge).time).toBe(17);
      expect(fake(bridge).paused).toBe(false);
    });

    it('leaves the transition for a seek outside it: the next song’s own file, after the switch', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await intoTransition(14);
      await act(async () => useClock.getState().seek(60));
      await settle();
      expect(now()).toBe(2);
      expect(fake(b).time).toBe(60);
      expect(fake(b).paused).toBe(false);
      expect(fake(bridge).paused).toBe(true);
      expect(fake(a).paused).toBe(true);
      expect(usePlayer.getState().playing).toBe(true);
    });

    it('leaves the transition for a seek outside it: the first song again, before the switch', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await intoTransition(4);
      await act(async () => useClock.getState().seek(100));
      await settle();
      expect(now()).toBe(1);
      expect(fake(a).time).toBe(100);
      expect(fake(a).paused).toBe(false);
      expect(fake(bridge).paused).toBe(true);
      expect(usePlayer.getState().playing).toBe(true);
    });

    it('pauses and resumes the transition', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await intoTransition(4);
      await act(async () => usePlayer.getState().setPlaying(false));
      expect(fake(bridge).paused).toBe(true);
      await act(async () => usePlayer.getState().setPlaying(true));
      await settle();
      expect(fake(bridge).paused).toBe(false);
      expect(fake(a).paused).toBe(true);
    });

    it('plays on without the transition when its file can’t load', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      await act(async () => {
        bridge.dispatchEvent(new Event('error'));
      });
      expect(src(bridge)).toBeNull();
      await at(a, 169.99);
      expect(fake(bridge).paused).toBe(true);
      expect(fake(a).paused).toBe(false);
      await at(a, 199.99);
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(0); // the next song from its start, without a gap
    });

    it('goes back to the first song when the transition fails while it plays', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await intoTransition(5);
      await act(async () => {
        bridge.dispatchEvent(new Event('error'));
      });
      await settle();
      expect(now()).toBe(1);
      expect(fake(a).time).toBe(175);
      expect(fake(a).paused).toBe(false);
      await at(a, 199.99);
      expect(now()).toBe(2);
      expect(fake(b).time).toBe(0);
      expect(fake(b).paused).toBe(false);
    });

    it('goes on in the next song when the transition fails after the switch', async () => {
      transitionReady(1, 2);
      const [, b, bridge] = await intoTransition(14);
      await act(async () => {
        bridge.dispatchEvent(new Event('error'));
      });
      await settle();
      expect(now()).toBe(2);
      expect(fake(b).time).toBe(22);
      expect(fake(b).paused).toBe(false);
    });

    it('plays on without the transition when the phone won’t let it start on its own', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await start([song(1), song(2)]);
      blocked.add(bridge);
      await at(a, 145);
      await at(a, 169.99);
      await overlap();
      expect(fake(a).paused).toBe(false);
      expect(usePlayer.getState().playing).toBe(true);
      await at(a, 199.99);
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
    });

    it('goes on with the next song in the first song’s player when the phone won’t start the other', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await intoTransition(12.1);
      blocked.add(b);
      await at(bridge, 23.99);
      expect(now()).toBe(2);
      expect(src(a)).toBe('/stream/2');
      expect(fake(a).time).toBe(32);
      expect(fake(a).paused).toBe(false);
      expect(usePlayer.getState().playing).toBe(true);
    });

    it('doesn’t start the transition when the sleep timer stops at the end of the song', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      useSleep.getState().sleepAtEndOfSong();
      await at(a, 145);
      await at(a, 169.99);
      expect(src(bridge)).toBeNull();
      expect(fake(a).paused).toBe(false);
      await end(a);
      expect(now()).toBe(2);
      expect(usePlayer.getState().playing).toBe(false);
    });

    it('ignores a transition for another pair of songs', async () => {
      transitionReady(1, 3);
      const [a, b, bridge] = await start([song(1), song(2), song(3)]);
      await at(a, 145);
      await at(a, 169.99);
      expect(src(bridge)).toBeNull();
      await at(a, 199.99);
      expect(now()).toBe(2);
      expect(fake(b).time).toBe(0);
    });

    it('drops a loaded transition when the next song changes before the mix point', async () => {
      transitionReady(1, 2, { continuationUrl: '/transitions/abc-rest.flac' });
      const [a, b, bridge] = await start([song(1), song(2), song(3)]);
      await at(a, 145);
      expect(src(bridge)).toBe(TRANSITION);
      await act(async () => usePlayer.getState().removeAt(1));
      expect(src(bridge)).toBeNull();
      await at(a, 169.99);
      expect(fake(bridge).paused).toBe(true);
      await at(a, 175);
      expect(src(b)).toBe('/stream/3');
      await at(a, 199.99);
      expect(now()).toBe(3);
    });

    it('levels the transition from the first song’s gain to the next one’s', async () => {
      // Songs whose levels weren't asked for yet in these tests.
      vi.spyOn(api, 'levels').mockResolvedValue({ r51: { track: -6 }, r52: { track: 0 } });
      transitionReady(51, 52);
      const [a, , bridge] = await intoTransition(0, [song(51), song(52)]);
      expect(fake(a).volume).toBeCloseTo(10 ** (-6 / 20), 2);
      expect(fake(bridge).volume).toBeCloseTo(10 ** (-6 / 20), 2);
      // 6 s in, the next song is a tenth of what's heard (its gain 0.25 against 0.75, in power).
      await at(bridge, 6);
      expect(fake(bridge).volume).toBeCloseTo(10 ** ((-6 * 0.9) / 20), 2);
    });
  });
});
