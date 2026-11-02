import type { MixMap, TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { AudioEngine } from './AudioEngine';
import { canSetVolume } from './decks';
import { useJoins } from './joins';
import { canLiveMix, type LiveMix, playLiveMix, prepareLiveMix } from './liveMix';
import { playTracker } from './playTracker';
import { useLevels } from './levels';
import { useOffline } from './offline';
import { useSleep } from './sleep';
import { currentTrack, useClock, usePlayer } from './store';
import { useTransition } from './transitions';

vi.mock('./loadAhead', () => ({ useLoadAhead: () => {} }));
vi.mock('./playTracker', () => ({ playTracker: { start: vi.fn(), finish: vi.fn(), tick: vi.fn(), pause: vi.fn() } }));
// iPhones fix the volume: some tests play as one.
vi.mock('./decks', async (importOriginal) => ({ ...(await importOriginal<typeof import('./decks')>()), canSetVolume: vi.fn(() => true) }));
// Live mixes are played by hand: jsdom has no Web Audio.
vi.mock('./liveMix', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./liveMix')>()),
  canLiveMix: vi.fn(() => false),
  prepareLiveMix: vi.fn(),
  playLiveMix: vi.fn(),
}));
// The tests say which transition is ready, instead of the server.
/** The graph that lines joins up on the sound: a stand-in, told what it will measure (see the desktop tests). */
const graph = vi.hoisted(() => ({
  instance: null as null | Record<string, unknown>,
}));
vi.mock('./joinGraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./joinGraph')>()),
  JoinGraph: { create: () => graph.instance },
}));
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
/** Elements whose play() takes this long (ms) to start, or never does. */
const slow = new Map<HTMLMediaElement, number | 'never'>();
/** A play() not started yet, refused if paused meanwhile (as browsers do). */
const pendingPlays = new Map<HTMLMediaElement, () => void>();

beforeEach(() => {
  // The engine's timers run on the test's clock, and performance.now() with it (the overlaps use it).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.mocked(canSetVolume).mockReturnValue(true);
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
    const delay = slow.get(this);
    if (delay === undefined) {
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      pendingPlays.set(this, () => reject(new DOMException('paused', 'AbortError')));
      if (delay === 'never') return;
      setTimeout(() => {
        if (!pendingPlays.delete(this)) return;
        this.dispatchEvent(new Event('playing'));
        resolve();
      }, delay);
    });
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    const f = fake(this);
    pendingPlays.get(this)?.();
    pendingPlays.delete(this);
    if (f.paused) return;
    f.paused = true;
    this.dispatchEvent(new Event('pause'));
  };
  HTMLMediaElement.prototype.load = function () {};
  vi.spyOn(api, 'levels').mockResolvedValue({});
  vi.spyOn(api, 'radio').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  usePrefs.setState({ transitions: 'off', crossfade: 0, levelVolume: true, autoplay: false });
  usePlayer.setState({ repeat: 'off', volume: 1, muted: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  blocked.clear();
  slow.clear();
  pendingPlays.clear();
  vi.clearAllMocks();
  useTransition.setState({ fromFileId: null, toFileId: null, result: null, ready: undefined });
  useSleep.getState().cancel();
});

const song = (id: number, albumId = id) =>
  ({ id, fileId: id, recordingId: `r${id}`, albumId, discNumber: 1, trackNumber: 1, duration: 200, title: `Song ${id}`, streamUrl: `/stream/${id}` }) as Track;

/** Time passes: timers due run, and what they start. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const settle = () => wait(10);
/** Past the short overlap where two files join. */
const overlap = () => wait(20);

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
function transitionReady(
  from: number,
  to: number,
  extra: { plan?: TransitionPlan; continuationUrl?: string; tail?: number; lead?: number; levels?: { a: number; b: number } } = {},
) {
  const result = {
    status: 'ready' as const,
    plan: extra.plan ?? plan(),
    url: TRANSITION,
    ...(extra.continuationUrl ? { continuationUrl: extra.continuationUrl } : {}),
    ...(extra.tail ? { tail: extra.tail } : {}),
    ...(extra.lead ? { lead: extra.lead } : {}),
    ...(extra.levels ? { levels: extra.levels } : {}),
  };
  useTransition.setState({ fromFileId: from, toFileId: to, result, ready: { ...result, fromFileId: from, toFileId: to } });
}

/** jsdom has no OS media controls: a stand-in that records the songs shown and the positions set. */
function stubMediaSession() {
  const titles: string[] = [];
  const session = {
    titles,
    setActionHandler: () => {},
    setPositionState: vi.fn(),
    playbackState: 'none',
    get metadata() {
      return null;
    },
    set metadata(m: { title: string } | null) {
      if (m) titles.push(m.title);
    },
  };
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    },
  );
  return session;
}

function unstubMediaSession() {
  delete (navigator as { mediaSession?: unknown }).mediaSession;
  vi.unstubAllGlobals();
}

/** Song 1 played into the transition, `t` seconds in. */
async function intoTransition(t: number, tracks = [song(1), song(2), song(3)]) {
  const decks = await start(tracks);
  const [a, , bridge] = decks;
  await at(a, 145);
  await at(a, 169.99);
  await inStepWith(a, 170.3, bridge, 0.3);
  if (t > 0) await at(bridge, t);
  return decks;
}

/**
 * A file started silenced (see inStep) reaches the moment the one playing is at (`followerTime` for
 * `leadTime`): it takes over, across the short overlap.
 */
async function inStepWith(lead: HTMLAudioElement, leadTime: number, follower: HTMLAudioElement, followerTime: number) {
  fake(follower).time = followerTime;
  await at(lead, leadTime);
  await wait(12); // steadily in step: the median of the last few checks
  await overlap();
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

  it('asks again for a song whose stream broke off, from where it stopped, before giving up', async () => {
    const fetchMock = vi.fn(async () => new Response('ab', { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    const [a] = await start([song(1), song(2)]);
    await at(a, 50);
    Object.defineProperty(a, 'error', { configurable: true, value: { code: 2 } });
    const breakOff = async () => {
      Object.defineProperty(a, 'readyState', { configurable: true, value: 0 });
      a.setAttribute('src', '/stream/1#broken'); // the element reloads only when its src is set
      await act(async () => {
        a.dispatchEvent(new Event('error'));
      });
      await settle();
    };
    for (let i = 0; i < 3; i++) {
      await breakOff();
      expect(src(a)).toBe('/stream/1');
      a.dispatchEvent(new Event('loadedmetadata'));
      expect(fake(a).time).toBe(50);
      expect(fake(a).paused).toBe(false);
      expect(useClock.getState().error).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await breakOff();
    expect(now()).toBe(1);
    expect(useClock.getState().error).toBe('The song kept stopping loading: the Playarr server or the network is too busy');
    expect(usePlayer.getState().playing).toBe(false);
    vi.unstubAllGlobals();
  });

  /** Levels already known for these songs (by recording id): songs no other test has asked about. */
  const knownLevels = (levels: Record<string, { track: number; album?: number }>) => useLevels.setState((s) => ({ levels: { ...s.levels, ...levels } }));

  it('plays a song whose level is known from its levelled stream, turned up or down there rather than by its volume', async () => {
    knownLevels({ r81: { track: -6 }, r82: { track: 4 } });
    const [a, b] = await start([song(81), song(82)]);
    expect(src(a)).toBe('/stream/81/levelled.wav?gain=-6');
    expect(fake(a).volume).toBe(1);
    await at(a, 175);
    expect(src(b)).toBe('/stream/82/levelled.wav?gain=4');
    expect(fake(b).volume).toBe(1);
  });

  it('plays the song’s own file with levelling off, or when it’s kept on this device (turned down by its volume)', async () => {
    knownLevels({ r83: { track: -6 }, r84: { track: -6 } });
    usePrefs.setState({ levelVolume: false });
    const [a] = await start([song(83)]);
    expect(src(a)).toBe('/stream/83');
    expect(fake(a).volume).toBe(1);
    cleanup();
    usePrefs.setState({ levelVolume: true });
    useOffline.setState({ songs: { 84: { url: '/stream/84', bytes: 1, usedAt: 0 } } });
    const [b] = await start([song(84)]);
    expect(src(b)).toBe('/stream/84');
    expect(fake(b).volume).toBeCloseTo(10 ** (-6 / 20), 2);
    useOffline.setState({ songs: {} });
  });

  it('goes on from the song’s own file, from where it was, when its levelled stream won’t play', async () => {
    knownLevels({ r85: { track: -3 } });
    const [a] = await start([song(85), song(86)]);
    await at(a, 50);
    Object.defineProperty(a, 'readyState', { configurable: true, value: 0 });
    await act(async () => {
      a.dispatchEvent(new Event('error'));
    });
    await settle();
    expect(src(a)).toBe('/stream/85');
    a.dispatchEvent(new Event('loadedmetadata'));
    expect(fake(a).time).toBe(50);
    expect(fake(a).paused).toBe(false);
    expect(useClock.getState().error).toBeNull();
    // Its volume levels it now, as far as a volume can.
    expect(fake(a).volume).toBeCloseTo(10 ** (-3 / 20), 2);
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
      // Started silenced, a moment ahead for the time starting takes: the first song is what's heard.
      expect(fake(bridge).paused).toBe(false);
      expect(bridge.muted).toBe(true);
      expect(fake(bridge).time).toBeCloseTo(0.05, 9);
      expect(fake(a).paused).toBe(false);
      // At the same moment of the first song: the transition takes over, across the short overlap.
      await inStepWith(a, 170.3, bridge, 0.3);
      expect(fake(a).paused).toBe(true);
      expect(bridge.muted).toBe(false);
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
      const { titles } = stubMediaSession();
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
        unstubMediaSession();
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

    it('leaves the transition’s volume alone when the songs’ levels were made into it', async () => {
      knownLevels({ r53: { track: -6 }, r54: { track: -2 } });
      transitionReady(53, 54, { levels: { a: -6, b: -2 } });
      const [a, , bridge] = await intoTransition(0, [song(53), song(54)]);
      expect(src(a)).toBe('/stream/53/levelled.wav?gain=-6');
      expect(fake(bridge).volume).toBe(1);
      await at(bridge, 6);
      expect(fake(bridge).volume).toBe(1);
    });

    it('starts the transition when the timer says, from where the song is and how fast it plays', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      a.playbackRate = 2;
      await at(a, 168); // 2 s of the song: 1 s at double speed, started 30 ms early
      await wait(950);
      expect(fake(bridge).paused).toBe(true);
      fake(a).time = 169.97;
      await wait(20);
      expect(fake(bridge).paused).toBe(false);
      expect(fake(bridge).time).toBeCloseTo(0.05, 9);
    });

    it('joins the transition where the song is, when the timer came late', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      await at(a, 169);
      fake(a).time = 170.5; // the timer, slowed in the background, fires half a second late
      await wait(1000);
      expect(fake(bridge).paused).toBe(false);
      expect(fake(bridge).time).toBeCloseTo(0.55, 9); // and a moment ahead, for the time starting takes
    });

    it('moves on to the next song at the switch on time, between timeupdates', async () => {
      transitionReady(1, 2);
      const [, , bridge] = await intoTransition(11);
      await wait(980);
      expect(now()).toBe(1);
      await wait(20);
      expect(now()).toBe(2);
      expect(fake(bridge).paused).toBe(false);
    });

    it('starts the next song when the transition ends, if no timer did, shown at its own time', async () => {
      transitionReady(1, 2, { continuationUrl: '/transitions/abc-rest.flac' });
      const [, b, bridge] = await intoTransition(10);
      vi.mocked(playTracker.finish).mockClear();
      vi.mocked(playTracker.start).mockClear();
      await end(bridge);
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(0);
      expect(clock()).toBe(32);
      expect(vi.mocked(playTracker.finish).mock.calls).toEqual([['ended']]);
      expect(vi.mocked(playTracker.start).mock.calls.map(([t]) => t.fileId)).toEqual([2]);
    });

    it('plays the first song on while a slow transition starts, then fades evenly across once they’re in step', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      slow.set(bridge, 100);
      await at(a, 145);
      await at(a, 169.99); // asked to start
      await wait(100); // started, silenced, catching up
      expect(fake(a).paused).toBe(false);
      expect(fake(a).volume).toBe(1);
      expect(bridge.muted).toBe(true);
      fake(bridge).time = 0.3;
      await act(async () => {
        fake(a).time = 170.3;
        a.dispatchEvent(new Event('timeupdate'));
      });
      await wait(12); // the next checks: steadily in step (the median of the last few), so the overlap starts
      await wait(8);
      // Both heard, evenly, partway across.
      expect(bridge.muted).toBe(false);
      expect(fake(a).volume).toBeGreaterThan(0);
      expect(fake(a).volume).toBeLessThan(1);
      expect(fake(a).volume + fake(bridge).volume).toBeCloseTo(1, 6);
      await overlap();
      expect(fake(a).paused).toBe(true);
      expect(fake(bridge).volume).toBe(1);
    });

    it('starts a transition with a lead of A that much early, and changes over in the lead, before B comes in', async () => {
      transitionReady(1, 2, { tail: 3, lead: 2 });
      const [a, , bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      await at(a, 167.99); // 2 s before the mix point: the file's start
      await wait(20);
      expect(fake(bridge).paused).toBe(false);
      expect(bridge.muted).toBe(true);
      expect(fake(bridge).time).toBeCloseTo(0.05, 9); // the file's start, a moment ahead
      // In step in the lead, where both files play A as it is: the transition takes over there.
      await inStepWith(a, 168.5, bridge, 0.5);
      expect(fake(a).paused).toBe(true);
      expect(bridge.muted).toBe(false);
      expect(useJoins.getState().last).toMatchObject({ join: 'into the transition', gapMs: 0 });
      // The file runs 2 s ahead of the transition: 8 s in is 6 s into the transition, still A.
      await at(bridge, 8);
      expect(clock()).toBe(176);
      expect(now()).toBe(1);
      // Past the switch (12 s into the transition): the next song.
      await at(bridge, 14.1);
      expect(now()).toBe(2);
    });

    describe('on desktop, lined up on the sound', () => {
      function fakeGraph(lags: (number | null)[]) {
        const routed = new Set<HTMLMediaElement>();
        const delays = new Map<HTMLMediaElement, number>();
        const g = {
          context: { currentTime: 10 },
          route: (el: HTMLMediaElement) => (routed.add(el), true),
          routed: (el: HTMLMediaElement) => routed.has(el),
          setLevel: vi.fn(),
          delayOf: (el: HTMLMediaElement) => delays.get(el) ?? 0,
          setDelay: vi.fn((el: HTMLMediaElement, s: number) => delays.set(el, s)),
          lag: vi.fn(async () => lags.shift() ?? null),
          crossfade: vi.fn(() => 10.04),
          release: vi.fn(),
          delays,
        };
        graph.instance = g;
        // A context the engine can make a graph on (the graph itself is the stand-in above).
        function FakeContext(this: Record<string, unknown>) {
          Object.assign(this, { state: 'running', currentTime: 10, resume: async () => {}, close: async () => {} });
        }
        Object.assign(FakeContext.prototype, { createMediaElementSource() {} });
        vi.stubGlobal('AudioContext', FakeContext);
        return g;
      }
      afterEach(() => {
        graph.instance = null;
        vi.unstubAllGlobals();
      });

      it('measures how far apart the two files sound, holds the new one back by that, and cross-fades on the audio clock', async () => {
        const g = fakeGraph([0.0213, 0.00001]);
        transitionReady(1, 2, { tail: 3, lead: 2 });
        const [a, , bridge] = await start([song(1), song(2)]);
        document.dispatchEvent(new Event('pointerdown')); // the first click: the elements go through the graph
        expect(g.routed(a) && g.routed(bridge)).toBe(true);
        expect(a.volume).toBe(1); // the level is the graph's
        await at(a, 145);
        await at(a, 167.99);
        await wait(20);
        expect(fake(bridge).paused).toBe(false);
        // Brought 20 ms ahead of A by the elements' times, then measured on the sound.
        fake(bridge).time = 0.52;
        await at(a, 168.5);
        await wait(12);
        await wait(400);
        expect(g.setDelay.mock.calls).toEqual([
          [bridge, 0],
          [bridge, 0.0213],
        ]);
        expect(g.crossfade).toHaveBeenCalledWith(a, bridge, 1, 1, 0.02);
        expect(useJoins.getState().last).toMatchObject({ join: 'into the transition', heard: true });
        expect(useJoins.getState().last!.gapMs).toBeCloseTo(0.01, 6);
        // A has stopped, the cross-fade over (by the audio clock: 40 ms from when it was asked).
        expect(fake(a).paused).toBe(true);
      });

      it('corrects once more when the check finds it still off, and falls back to the elements’ times when the sound can’t be measured', async () => {
        const g = fakeGraph([0.03, 0.0004, 0]);
        transitionReady(1, 2, { tail: 3, lead: 2 });
        const [a, , bridge] = await start([song(1), song(2)]);
        document.dispatchEvent(new Event('pointerdown'));
        await at(a, 145);
        await at(a, 167.99);
        await wait(20);
        fake(bridge).time = 0.52;
        await at(a, 168.5);
        await wait(600);
        expect(g.setDelay.mock.calls.map(([, s]) => s)).toEqual([0, 0.03, 0.0304]);
        expect(useJoins.getState().last).toMatchObject({ gapMs: 0, heard: true });

        // Nothing to measure by (silence, say): held back by the 20 ms it was brought ahead, cross-faded as before.
        cleanup();
        const silent = fakeGraph([null]);
        transitionReady(1, 2, { tail: 3, lead: 2 });
        const [a2, , bridge2] = await start([song(1), song(2)]);
        document.dispatchEvent(new Event('pointerdown'));
        await at(a2, 145);
        await at(a2, 167.99);
        await wait(20);
        fake(bridge2).time = 0.52;
        await at(a2, 168.5);
        await wait(400);
        expect(silent.setDelay.mock.calls.map(([, s]) => s)).toEqual([0, 0.02]);
        expect(silent.crossfade).not.toHaveBeenCalled();
        expect(useJoins.getState().last).toMatchObject({ join: 'into the transition' });
        expect(useJoins.getState().last!.heard).toBeUndefined();
        await overlap();
        expect(fake(a2).paused).toBe(true);
      });
    });

    it('changes over to the next song’s own file in the transition’s tail, in step, fading across', async () => {
      transitionReady(1, 2, { tail: 3 });
      const [, b, bridge] = await intoTransition(12.1);
      expect(now()).toBe(2);
      // The transition over: B's own file starts silenced in its tail (B on its own), the transition heard.
      await at(bridge, 23.99);
      expect(fake(b).paused).toBe(false);
      expect(b.muted).toBe(true);
      expect(fake(bridge).paused).toBe(false);
      // In step: B's own file takes over, across the short overlap, and the transition is let go.
      await inStepWith(bridge, 24.4, b, 32.4);
      expect(b.muted).toBe(false);
      expect(fake(bridge).paused).toBe(true);
      expect(src(bridge)).toBeNull();
      await at(b, 40);
      expect(clock()).toBe(40);
    });

    it('gives up on a transition that doesn’t start: the first song never stopped, the next follows', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await start([song(1), song(2)]);
      slow.set(bridge, 'never');
      await at(a, 145);
      await at(a, 169.99);
      await wait(1470);
      expect(fake(bridge).paused).toBe(false); // still starting, silenced: the first song is heard
      expect(fake(a).volume).toBe(1);
      await wait(30);
      expect(fake(bridge).paused).toBe(true);
      expect(src(bridge)).toBeNull();
      expect(fake(a).paused).toBe(false);
      expect(fake(a).volume).toBe(1);
      expect(usePlayer.getState().playing).toBe(true);
      await at(a, 185);
      expect(clock()).toBe(185); // the first song's time again
      await at(a, 199.99);
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
    });

    it('pauses while the transition starts, and starts it again where the song is when played', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      slow.set(bridge, 100);
      await at(a, 145);
      await at(a, 169.99);
      await act(async () => usePlayer.getState().setPlaying(false));
      expect(fake(a).paused).toBe(true);
      expect(fake(bridge).paused).toBe(true);
      await wait(500);
      expect(usePlayer.getState().playing).toBe(false);
      slow.clear();
      await act(async () => usePlayer.getState().setPlaying(true));
      await settle();
      expect(fake(a).paused).toBe(false);
      await at(a, 170.2);
      expect(fake(bridge).paused).toBe(false);
      expect(fake(bridge).time).toBeCloseTo(0.25, 6); // where the song is, and a moment ahead
    });

    it('pauses and seeks during the joins', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await start([song(1), song(2), song(3)]);
      await at(a, 145);
      await at(a, 169.99); // 10 ms into the 15 ms overlap
      await act(async () => usePlayer.getState().setPlaying(false));
      expect(fake(a).paused).toBe(true);
      expect(fake(bridge).paused).toBe(true);
      await act(async () => usePlayer.getState().setPlaying(true));
      await settle();
      expect(fake(bridge).paused).toBe(false);
      expect(fake(a).paused).toBe(true);
      await at(bridge, 12.1);
      await at(bridge, 23.99); // into B's overlap
      await act(async () => usePlayer.getState().setPlaying(false));
      expect(fake(b).paused).toBe(true);
      expect(fake(bridge).paused).toBe(true);
      await act(async () => usePlayer.getState().setPlaying(true));
      await settle();
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(32);
      expect(fake(bridge).paused).toBe(true);
      await act(async () => useClock.getState().seek(60));
      expect(fake(b).time).toBe(60);
    });

    it('seeks out of the transition during the first join', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      await at(a, 169.99);
      await act(async () => useClock.getState().seek(100));
      await overlap();
      expect(fake(a).time).toBe(100);
      expect(fake(a).paused).toBe(false);
      expect(fake(a).volume).toBe(1);
      expect(fake(bridge).paused).toBe(true);
    });

    it('stops where the transition ends when the sleep timer is set during it', async () => {
      transitionReady(1, 2);
      const [, b, bridge] = await intoTransition(5);
      useSleep.getState().sleepAtEndOfSong();
      await at(bridge, 12.1);
      expect(now()).toBe(2);
      expect(usePlayer.getState().playing).toBe(true); // the blend plays out
      expect(fake(bridge).paused).toBe(false);
      await at(bridge, 23.99);
      expect(usePlayer.getState().playing).toBe(false);
      expect(fake(bridge).paused).toBe(true);
      expect(fake(b).paused).toBe(true);
      expect(fake(b).time).toBe(32); // ready to go on from there
      expect(useSleep.getState().endOfSong).toBe(false);
      await act(async () => usePlayer.getState().setPlaying(true));
      await settle();
      expect(fake(b).paused).toBe(false);
    });

    it('goes back to the first song when the next one is taken out of the queue during the transition', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await intoTransition(5);
      await act(async () => usePlayer.getState().removeAt(1));
      await settle();
      expect(now()).toBe(1);
      expect(fake(a).time).toBe(175);
      expect(fake(a).paused).toBe(false);
      expect(fake(bridge).paused).toBe(true);
      await at(a, 199.99);
      expect(now()).toBe(3);
      expect(src(b)).toBe('/stream/3');
    });

    it('mixes round the queue with repeat all', async () => {
      usePlayer.setState({ repeat: 'all' });
      transitionReady(1, 2);
      const [a, b, bridge] = await intoTransition(12.5, [song(1), song(2)]);
      await at(bridge, 23.99);
      await overlap();
      expect(now()).toBe(2);
      transitionReady(2, 1);
      await at(b, 145);
      expect(src(a)).toBe('/stream/1');
      expect(fake(a).time).toBe(32);
      expect(src(bridge)).toBe(TRANSITION);
      await at(b, 169.99);
      await inStepWith(b, 170.3, bridge, 0.3);
      await at(bridge, 12.5);
      expect(now()).toBe(1);
      expect(usePlayer.getState().pos).toBe(0);
      await at(bridge, 23.99);
      await overlap();
      expect(fake(a).paused).toBe(false);
      expect(fake(a).time).toBe(32);
      expect(fake(b).paused).toBe(true);
    });

    it('restarts the first song for previous before the switch', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await intoTransition(5);
      await act(async () => usePlayer.getState().prev(clock()));
      await settle();
      expect(now()).toBe(1);
      expect(fake(a).time).toBe(0);
      expect(fake(a).paused).toBe(false);
      expect(fake(bridge).paused).toBe(true);
    });

    it('restarts the next song from its own file for previous after the switch', async () => {
      transitionReady(1, 2, { continuationUrl: '/transitions/abc-rest.flac' });
      const [, b, bridge] = await intoTransition(14);
      vi.mocked(playTracker.finish).mockClear();
      await act(async () => usePlayer.getState().prev(clock()));
      await settle();
      expect(now()).toBe(2);
      expect(src(b)).toBe('/stream/2');
      expect(fake(b).time).toBe(0);
      expect(fake(b).paused).toBe(false);
      expect(fake(bridge).paused).toBe(true);
      expect(vi.mocked(playTracker.finish).mock.calls).toEqual([['ended']]);
    });

    it('goes on in the next song’s own file when the transition stays stuck loading', async () => {
      transitionReady(1, 2);
      const [, b, bridge] = await intoTransition(5);
      vi.mocked(playTracker.finish).mockClear();
      await act(async () => {
        bridge.dispatchEvent(new Event('waiting'));
      });
      await wait(3980);
      expect(now()).toBe(1);
      await wait(20);
      expect(now()).toBe(2);
      expect(fake(b).time).toBe(13);
      expect(fake(b).paused).toBe(false);
      expect(fake(bridge).paused).toBe(true);
      expect(vi.mocked(playTracker.finish).mock.calls).toEqual([['ended']]);
    });

    it('goes back to the first song when the transition is stuck and the next song isn’t loaded either', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await intoTransition(5);
      Object.defineProperty(b, 'readyState', { configurable: true, value: 1 });
      await act(async () => {
        bridge.dispatchEvent(new Event('stalled'));
      });
      await wait(4000);
      expect(now()).toBe(1);
      expect(fake(a).time).toBe(175);
      expect(fake(a).paused).toBe(false);
    });

    it('waits out a short stall in the transition', async () => {
      transitionReady(1, 2);
      const [, , bridge] = await intoTransition(5);
      await act(async () => {
        bridge.dispatchEvent(new Event('waiting'));
      });
      await wait(1000);
      await act(async () => {
        bridge.dispatchEvent(new Event('playing'));
      });
      await wait(5000);
      expect(fake(bridge).paused).toBe(false);
      expect(now()).toBe(1);
    });

    it('gives the lock screen the next song’s rate during the transition', async () => {
      const session = stubMediaSession();
      try {
        transitionReady(1, 2, { plan: plan({ bRate: [{ at: 0, value: 1.1 }], bResume: 34.4 }) });
        const [, , bridge] = await intoTransition(5);
        await at(bridge, 12.1);
        expect(session.setPositionState).toHaveBeenLastCalledWith(expect.objectContaining({ playbackRate: 1.1 }));
        session.setPositionState.mockClear();
        await at(bridge, 12.6);
        expect(session.setPositionState).not.toHaveBeenCalled(); // about once a second
        await wait(1000);
        await at(bridge, 13.6);
        expect(session.setPositionState).toHaveBeenCalledWith(expect.objectContaining({ position: expect.closeTo(8 + 13.6 * 1.1, 6) }));
      } finally {
        unstubMediaSession();
      }
    });

    describe('on an iPhone (the volume fixed)', () => {
      beforeEach(() => {
        vi.mocked(canSetVolume).mockReturnValue(false);
      });

      it('starts the transition silenced while the first song plays on, and changes over once they’re in step', async () => {
        transitionReady(1, 2, { tail: 3 });
        const [a, b, bridge] = await start([song(1), song(2), song(3)]);
        await at(a, 145);
        await at(a, 169.99);
        // A moment ahead (for the time starting takes), and catching up or waiting meanwhile: A is what's heard.
        expect(fake(bridge).paused).toBe(false);
        expect(bridge.muted).toBe(true);
        expect(fake(bridge).time).toBeCloseTo(0.05, 9);
        expect(fake(a).paused).toBe(false);
        expect(bridge.playbackRate).toBeLessThan(1);
        // Both at the same moment of A: the transition takes over.
        fake(bridge).time = 0.3;
        await at(a, 170.3);
        expect(fake(a).paused).toBe(true);
        expect(bridge.muted).toBe(false);
        expect(bridge.playbackRate).toBe(1);
        expect(usePlayer.getState().playing).toBe(true);
        await at(bridge, 6);
        expect(clock()).toBe(176);
        await at(bridge, 12.1);
        expect(now()).toBe(2);
        // The transition over, B's own file starts silenced in its tail (B on its own), and takes over in step.
        await at(bridge, 23.99);
        expect(fake(b).paused).toBe(false);
        expect(b.muted).toBe(true);
        expect(fake(bridge).paused).toBe(false);
        fake(bridge).time = 24.4;
        await at(b, 32.4);
        await wait(12); // steadily in step
        expect(b.muted).toBe(false);
        expect(fake(bridge).paused).toBe(true);
        expect(src(bridge)).toBeNull();
        await at(b, 40);
        expect(clock()).toBe(40);
      });

      it('lets a paused changeover take over at once, so nothing plays on', async () => {
        transitionReady(1, 2, { tail: 3 });
        const [a, , bridge] = await start([song(1), song(2), song(3)]);
        await at(a, 145);
        await at(a, 169.99);
        expect(bridge.muted).toBe(true);
        await act(async () => usePlayer.getState().setPlaying(false));
        await settle();
        expect(fake(a).paused).toBe(true);
        expect(fake(bridge).paused).toBe(true);
        expect(bridge.muted).toBe(false);
      });

      it('changes over at the end of an older transition file, with no tail', async () => {
        transitionReady(1, 2);
        const [a, b, bridge] = await start([song(1), song(2), song(3)]);
        await at(a, 145);
        await at(a, 169.99);
        fake(bridge).time = 0.3;
        await at(a, 170.3);
        expect(fake(a).paused).toBe(true);
        await at(bridge, 6);
        expect(clock()).toBe(176);
        await at(bridge, 12.1);
        expect(now()).toBe(2);
        await at(bridge, 23.99);
        expect(fake(b).paused).toBe(false);
        expect(fake(b).time).toBe(32);
        expect(fake(bridge).paused).toBe(true);
        expect(fake(bridge).volume).toBe(1);
        await at(b, 40);
        expect(clock()).toBe(40);
      });

      it('plays the first song on when the transition doesn’t start', async () => {
        transitionReady(1, 2);
        const [a, , bridge] = await start([song(1), song(2)]);
        slow.set(bridge, 'never');
        await at(a, 145);
        await at(a, 169.99);
        expect(fake(a).paused).toBe(false);
        await wait(1500);
        expect(fake(a).paused).toBe(false);
        expect(fake(bridge).paused).toBe(true);
        expect(bridge.muted).toBe(false);
        expect(usePlayer.getState().playing).toBe(true);
      });
    });
  });

  describe('cuts on the beat, with no transition ready', () => {
    /** A 120 BPM song: bars every 2 s from 1 s, its sound ending at 196.4 s (so its last downbeat is 195). */
    const map = (over: Partial<MixMap> = {}): MixMap => ({
      version: 1,
      duration: 200,
      bpm: 120,
      firstBeat: 0.5,
      downbeatOffset: 1,
      downbeatConfidence: 0.9,
      gridStable: true,
      beatConfidence: 0.9,
      introEnd: 9,
      outroStart: 180,
      coldStart: false,
      coldEnd: false,
      soundEnd: 196.4,
      phraseEnergy: [],
      ...over,
    });

    beforeEach(() => {
      usePrefs.setState({ transitions: 'dj' });
    });

    it('leaves the song on its last downbeat and starts the next on its first', async () => {
      // Songs whose maps weren't asked for yet in these tests (they're kept a minute).
      vi.spyOn(api, 'mixMaps').mockResolvedValue({ r61: map(), r62: map({ firstBeat: 0.2, downbeatOffset: 2 }) });
      const [a, b] = await start([song(61), song(62)]);
      await at(a, 175);
      expect(src(b)).toBe('/stream/62');
      expect(fake(b).time).toBe(1.2); // waiting on its first downbeat
      await at(a, 194); // a second before the downbeat at 195: started 30 ms early
      await wait(950);
      expect(now()).toBe(61);
      await wait(20);
      expect(now()).toBe(62);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(1.2);
      expect(clock()).toBe(1.2);
      await overlap();
      expect(fake(a).paused).toBe(true); // its tail isn't played out
      expect(playTracker.finish).toHaveBeenCalledWith('ended');
    });

    it('on an iPhone, starts the next song silenced just before its downbeat, and changes over on the downbeat', async () => {
      vi.mocked(canSetVolume).mockReturnValue(false);
      vi.spyOn(api, 'mixMaps').mockResolvedValue({ r67: map(), r68: map() });
      const [a, b] = await start([song(67), song(68)]);
      await at(a, 175);
      expect(fake(b).time).toBe(0.5); // half a second before its first downbeat, at 1 s
      await at(a, 194);
      await wait(470); // A at 194.5 (its clock is the test's): B starts, silenced, a moment ahead
      expect(fake(b).paused).toBe(false);
      expect(b.muted).toBe(true);
      expect(now()).toBe(67);
      fake(b).time = 1;
      await at(a, 195);
      expect(b.muted).toBe(false);
      expect(fake(a).paused).toBe(true);
      expect(now()).toBe(68);
    });

    it('plays the songs one after the other as usual without their maps', async () => {
      const [a, b] = await start([song(63), song(64)]);
      await at(a, 194);
      await wait(1500);
      expect(now()).toBe(63);
      await at(a, 199.99);
      expect(now()).toBe(64);
      expect(fake(b).time).toBe(0);
    });

    it('plays the song out when the sleep timer stops at its end', async () => {
      vi.spyOn(api, 'mixMaps').mockResolvedValue({ r65: map(), r66: map() });
      const [a] = await start([song(65), song(66)]);
      useSleep.getState().sleepAtEndOfSong();
      await at(a, 194);
      await wait(1500);
      expect(now()).toBe(65);
      expect(fake(a).paused).toBe(false);
    });
  });

  describe('starting a song somewhere', () => {
    it('starts a song picked to play from a point there, as it loads, not the song that was playing', async () => {
      const [a] = await start([song(1), song(2), song(3)]);
      await at(a, 50);
      // As the mix points dialog plays a song from a marker: in after the current one, from there.
      Object.defineProperty(a, 'readyState', { configurable: true, value: 0 }); // the new file not known yet
      await act(async () => {
        usePlayer.getState().playNext([song(9)]);
        usePlayer.getState().jumpTo(1, { at: 42 });
      });
      await settle();
      expect(now()).toBe(9);
      expect(src(a)).toBe('/stream/9');
      expect(fake(a).time).toBe(50); // not moved before it knows its file
      expect(clock()).toBe(42);
      a.dispatchEvent(new Event('loadedmetadata'));
      expect(fake(a).time).toBe(42);
      expect(usePlayer.getState().startAt).toBeNull();
    });

    it('starts a song already loaded there, and a new queue too', async () => {
      const [a, b] = await start([song(1), song(2)]);
      await at(a, 175); // the next song loads ahead
      await act(async () => usePlayer.getState().jumpTo(1, { at: 30 }));
      await settle();
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(30);
      await act(async () => usePlayer.getState().playTracks([song(5)], 0, { at: 12 }));
      await settle();
      expect(now()).toBe(5);
      expect(fake(b).time).toBe(12);
    });
  });

  describe('live mixes on desktop, for a press of Next', () => {
    /** A quick mix rendered from 62.5 s into the first song: 6 s long, B showing from 3 s, B resuming at 36 s. */
    const quick = plan({ style: 'quick', aStart: 62.5, length: 6, switchAt: 3, bStart: 30, bResume: 36 });
    const resume = vi.fn(() => Promise.resolve());
    const suspend = vi.fn(() => Promise.resolve());
    /** The mix as playLiveMix plays it: its clock (seconds into it, negative before) is the test's to move. */
    let mixed: { time: number; volume: number; stop: ReturnType<typeof vi.fn>; started: () => Promise<void>; landed: () => Promise<void> };

    beforeEach(() => {
      usePrefs.setState({ transitions: 'dj' });
      vi.mocked(canLiveMix).mockReturnValue(true);
      vi.stubGlobal(
        'AudioContext',
        class {
          state = 'running';
          resume = resume;
          suspend = suspend;
          close = () => Promise.resolve();
        },
      );
      vi.mocked(prepareLiveMix).mockImplementation(
        ({ a, b }) => new Promise((done) => setTimeout(() => done({ plan: quick, buffer: {} as AudioBuffer, from: a, to: b } satisfies LiveMix), 300)),
      );
      vi.mocked(playLiveMix).mockImplementation((mix, { a, b, onStarted, onLanded }) => {
        // As the real one: B waits where the mix leaves it; A stops as the mix starts; B starts as it ends.
        b.pause();
        b.currentTime = mix.plan.bResume;
        const stop = vi.fn();
        mixed = {
          time: -1,
          volume: 1,
          stop,
          // As the real one: A's element fades out over 15 ms from the mix's start, then pauses.
          started: () =>
            act(async () => {
              mixed.time = 0.015;
              a.pause();
              onStarted?.();
            }),
          landed: () =>
            act(async () => {
              mixed.time = mix.plan.length;
              onLanded?.(b.play());
            }),
        };
        return { startsAt: 0, time: () => mixed.time, setVolume: (v) => (mixed.volume = v), stop };
      });
    });

    afterEach(() => {
      vi.mocked(canLiveMix).mockReturnValue(false);
      vi.unstubAllGlobals();
    });

    /** Move the mix's clock on, and the time with it. */
    async function mixAt(t: number, ms = LIVE_STEP_MS) {
      mixed.time = t;
      await wait(ms);
    }
    const LIVE_STEP_MS = 100;
    const press = () => act(async () => usePlayer.getState().next());

    it('mixes into the next song: the first plays on meanwhile, the store moves once at the switch, the next goes on from the mix', async () => {
      const { titles } = stubMediaSession();
      try {
        const [a, b] = await start([song(1), song(2), song(3)]);
        await at(a, 60);
        vi.mocked(playTracker.start).mockClear();
        vi.mocked(playTracker.finish).mockClear();
        await press();
        expect(resume).toHaveBeenCalled(); // Web Audio woken within the press
        expect(now()).toBe(1);
        expect(fake(a).paused).toBe(false);
        expect(src(b)).toBe('/stream/2'); // loading meanwhile
        expect(prepareLiveMix).toHaveBeenCalledWith(expect.objectContaining({ aPosition: 60, mode: 'auto' }));
        await wait(300);
        expect(playLiveMix).toHaveBeenCalledOnce();
        expect(now()).toBe(1);
        await mixed.started();
        expect(fake(a).paused).toBe(true);
        expect(usePlayer.getState().playing).toBe(true);
        await mixAt(1);
        expect(clock()).toBe(63.5); // the first song's time, inside the mix (from its start at 62.5)
        await mixAt(2.5); // half a second before the switch (the tick that sees it comes at the end of the step)
        await wait(490);
        expect(now()).toBe(1);
        await wait(20);
        expect(now()).toBe(2);
        await mixAt(4);
        expect(clock()).toBe(34); // the next song's time, inside the mix
        await mixed.landed();
        expect(fake(b).paused).toBe(false);
        expect(fake(b).time).toBe(36);
        expect(clock()).toBe(36);
        await at(b, 40);
        expect(clock()).toBe(40);
        expect(titles).toEqual(['Song 1', 'Song 2']);
        // Two plays: the first song left at the switch (skipped: Next was pressed, so the skip rules apply),
        // the second counts from there.
        expect(vi.mocked(playTracker.finish).mock.calls).toEqual([['changed']]);
        expect(vi.mocked(playTracker.start).mock.calls.map(([t]) => t.fileId)).toEqual([2]);
        expect(playTracker.tick).toHaveBeenCalledWith(34);
      } finally {
        unstubMediaSession();
      }
    });

    it('levels the mix like a transition', async () => {
      vi.spyOn(api, 'levels').mockResolvedValue({ r71: { track: -6 }, r72: { track: 0 } });
      const [a] = await start([song(71), song(72)]);
      await at(a, 60);
      await press();
      await wait(300);
      await mixed.started();
      expect(mixed.volume).toBeCloseTo(10 ** (-6 / 20), 2);
    });

    it('leaves the first song’s volume to the mix while it fades it out', async () => {
      const [a] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await wait(300);
      mixed.time = 0.005; // the mix has started: playLiveMix is fading A out
      fake(a).volume = 0.4;
      await act(async () => usePlayer.getState().setVolume(0.9));
      expect(fake(a).volume).toBe(0.4);
      await mixed.started();
      await act(async () => usePlayer.getState().setVolume(1));
      expect(fake(a).volume).toBe(1); // its own again once paused (for when it plays again)
    });

    it('skips at once when no mix can be made', async () => {
      vi.mocked(prepareLiveMix).mockResolvedValue(null);
      const [a, b] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await settle();
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(0);
      expect(fake(a).paused).toBe(true);
    });

    it('skips at once when making the mix takes too long', async () => {
      vi.mocked(prepareLiveMix).mockReturnValue(new Promise(() => {}));
      const [a] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await wait(1700);
      expect(now()).toBe(1);
      await wait(60);
      expect(now()).toBe(2);
    });

    it('skips at once for a second press while the mix is made', async () => {
      const [a, b] = await start([song(1), song(2), song(3)]);
      await at(a, 60);
      await press();
      const { signal } = vi.mocked(prepareLiveMix).mock.calls[0]![0];
      await press();
      await settle();
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(0);
      expect(signal.aborted).toBe(true);
      await wait(400);
      expect(playLiveMix).not.toHaveBeenCalled();
      expect(now()).toBe(2);
    });

    it('skips at once, paused, when paused while the mix is made', async () => {
      const [a, b] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await act(async () => usePlayer.getState().setPlaying(false));
      await settle();
      expect(now()).toBe(2);
      expect(usePlayer.getState().playing).toBe(false);
      expect(fake(a).paused).toBe(true);
      expect(fake(b).paused).toBe(true);
    });

    it('goes on in the next song where the mix had it when paused during it', async () => {
      const [a, b] = await start([song(1), song(2)]);
      await at(a, 60);
      vi.mocked(playTracker.finish).mockClear();
      await press();
      await wait(300);
      await mixed.started();
      await mixAt(2);
      await act(async () => usePlayer.getState().setPlaying(false));
      await settle();
      expect(mixed.stop).toHaveBeenCalled();
      expect(now()).toBe(2);
      expect(usePlayer.getState().playing).toBe(false);
      expect(fake(b).time).toBe(32);
      expect(fake(b).paused).toBe(true);
      expect(vi.mocked(playTracker.finish).mock.calls).toEqual([['changed']]); // left for a press of Next
      await act(async () => usePlayer.getState().setPlaying(true));
      await settle();
      expect(fake(b).paused).toBe(false);
    });

    it('seeks in the next song’s own element past the switch', async () => {
      const [a, b] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await wait(300);
      await mixed.started();
      await mixAt(4);
      expect(now()).toBe(2);
      await act(async () => useClock.getState().seek(80));
      await settle();
      expect(mixed.stop).toHaveBeenCalled();
      expect(fake(b).time).toBe(80);
      expect(fake(b).paused).toBe(false);
      expect(now()).toBe(2);
    });

    it('goes into the next song where the mix had it for another press during it', async () => {
      const [a, b] = await start([song(1), song(2), song(3)]);
      await at(a, 60);
      await press();
      await wait(300);
      await mixed.started();
      await mixAt(2);
      await press();
      await settle();
      expect(now()).toBe(2);
      expect(fake(b).time).toBe(32);
      expect(fake(b).paused).toBe(false);
      expect(mixed.stop).toHaveBeenCalled();
    });

    it('keeps today’s skip on phones and tablets', async () => {
      vi.mocked(canLiveMix).mockReturnValue(false);
      const [a] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      expect(now()).toBe(2);
      expect(src(a)).toBe('/stream/2'); // loaded at once, as ever
      expect(fake(a).paused).toBe(false);
      expect(prepareLiveMix).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });

    it('waits for a transition from the server about to start, instead of mixing live', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      await at(a, 168);
      await press();
      expect(now()).toBe(1);
      expect(prepareLiveMix).not.toHaveBeenCalled();
      await at(a, 169.99);
      expect(fake(bridge).paused).toBe(false);
      await overlap();
      await at(bridge, 12.1);
      expect(now()).toBe(2);
      await at(bridge, 23.99);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(32);
    });

    it('skips at once if the transition it waited for won’t play', async () => {
      transitionReady(1, 2);
      const [a, b, bridge] = await start([song(1), song(2)]);
      slow.set(bridge, 'never');
      await at(a, 145);
      await at(a, 168);
      await press();
      await at(a, 169.99);
      await wait(1510); // the transition never starts
      expect(now()).toBe(2);
      expect(fake(b).paused).toBe(false);
      expect(fake(b).time).toBe(0);
    });

    it('mixes live when the transition from the server starts too far off', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      expect(src(bridge)).toBe(TRANSITION);
      await press();
      expect(prepareLiveMix).toHaveBeenCalled();
      expect(src(bridge)).toBeNull();
      expect(now()).toBe(1);
    });

    it('counts the song left for a transition waited for by a press of Next as skipped, one heard through as ended', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      await at(a, 145);
      await at(a, 168);
      vi.mocked(playTracker.finish).mockClear();
      await press();
      await at(a, 169.99);
      await overlap();
      await at(bridge, 12.1);
      expect(vi.mocked(playTracker.finish).mock.calls).toEqual([['changed']]);
    });

    it('skips at once, paused, when paused while the transition it waited for starts', async () => {
      transitionReady(1, 2);
      const [a, , bridge] = await start([song(1), song(2)]);
      slow.set(bridge, 100);
      await at(a, 145);
      await at(a, 168);
      await press();
      await at(a, 169.99); // the transition asked to start
      await act(async () => usePlayer.getState().setPlaying(false));
      await settle();
      expect(now()).toBe(2);
      expect(usePlayer.getState().playing).toBe(false);
      expect(fake(bridge).paused).toBe(true);
    });

    it('skips at once when the mix can’t be set going', async () => {
      vi.mocked(playLiveMix).mockImplementation(() => {
        throw new Error('no Web Audio after all');
      });
      const [a] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await wait(300);
      expect(now()).toBe(2);
    });

    it('waits for the next song to load enough before setting the mix going, within the time allowed', async () => {
      const [a, b] = await start([song(1), song(2)]);
      Object.defineProperty(b, 'readyState', { configurable: true, value: 1 });
      await at(a, 60);
      await press();
      await wait(300);
      expect(playLiveMix).not.toHaveBeenCalled();
      expect(now()).toBe(1);
      Object.defineProperty(b, 'readyState', { configurable: true, value: 4 });
      await act(async () => {
        b.dispatchEvent(new Event('canplay'));
      });
      expect(playLiveMix).toHaveBeenCalledOnce();
      expect(now()).toBe(1);
    });

    it('skips at once when the next song doesn’t load in time for the mix', async () => {
      const [a, b] = await start([song(1), song(2)]);
      Object.defineProperty(b, 'readyState', { configurable: true, value: 1 });
      await at(a, 60);
      await press();
      await wait(1760);
      expect(playLiveMix).not.toHaveBeenCalled();
      expect(now()).toBe(2);
    });

    it('stops where the mix ends when the sleep timer is set during it', async () => {
      const [a, b] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await wait(300);
      await mixed.started();
      useSleep.getState().sleepAtEndOfSong();
      await mixAt(4);
      expect(now()).toBe(2);
      expect(usePlayer.getState().playing).toBe(true); // the mix plays out
      await mixed.landed();
      expect(usePlayer.getState().playing).toBe(false);
      expect(fake(b).paused).toBe(true);
      expect(fake(b).time).toBe(36);
      expect(useSleep.getState().endOfSong).toBe(false);
    });

    it('lets Web Audio rest after a mix', async () => {
      const [a] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await wait(300);
      await mixed.started();
      await mixAt(4);
      await mixed.landed();
      await wait(250);
      expect(suspend).toHaveBeenCalled();
    });

    it('never mixes for a press of Next with repeat one', async () => {
      usePlayer.setState({ repeat: 'one' });
      const [a] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      expect(now()).toBe(2);
      expect(prepareLiveMix).not.toHaveBeenCalled();
    });

    it('goes on with the next press of Next when the queue empties during a mix', async () => {
      const [a] = await start([song(1), song(2)]);
      await at(a, 60);
      await press();
      await wait(300);
      await mixed.started();
      await act(async () => usePlayer.setState({ queue: [], order: [], pos: -1 }));
      await settle();
      expect(mixed.stop).toHaveBeenCalled();
    });

    it('skips at once with mixing off for the queue, or the sleep timer at the end of the song', async () => {
      const [a] = await start([song(1), song(2), song(3)]);
      usePlayer.getState().setMixMode('off');
      await at(a, 60);
      await press();
      expect(now()).toBe(2);
      usePlayer.getState().setMixMode('auto');
      useSleep.getState().sleepAtEndOfSong();
      await press();
      expect(now()).toBe(3);
      expect(prepareLiveMix).not.toHaveBeenCalled();
    });
  });

  it('goes on from the song’s own file when its remainder file disappears while it plays', async () => {
    transitionReady(1, 2, { continuationUrl: '/transitions/abc-rest.flac' });
    const [, b] = await intoTransition(12.1);
    const bridge = document.querySelectorAll('audio')[2]!;
    await at(bridge, 23.99);
    await at(b, 10); // B at 42 s, from its remainder
    Object.defineProperty(b, 'readyState', { configurable: true, value: 0 });
    await act(async () => {
      b.dispatchEvent(new Event('error'));
    });
    await settle();
    expect(src(b)).toBe('/stream/2');
    expect(useClock.getState().error).toBeNull();
    b.dispatchEvent(new Event('loadedmetadata'));
    expect(fake(b).time).toBe(42);
    expect(fake(b).paused).toBe(false);
  });

  it('moves a song only to the latest time asked for once its file is known', async () => {
    usePrefs.setState({ transitions: 'dj' });
    const [a] = await start([song(1), song(2), song(3)]);
    await at(a, 50);
    Object.defineProperty(a, 'readyState', { configurable: true, value: 0 });
    await act(async () => {
      usePlayer.getState().playNext([song(9)]);
      usePlayer.getState().jumpTo(1, { at: 42 });
    });
    await settle();
    // The file known, a seek moves it at once; the time asked for before mustn't move it back after.
    Object.defineProperty(a, 'readyState', { configurable: true, value: 1 });
    await act(async () => useClock.getState().seek(80));
    expect(fake(a).time).toBe(80);
    a.dispatchEvent(new Event('loadedmetadata'));
    expect(fake(a).time).toBe(80);
  });
});
