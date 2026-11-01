import type { Track } from '@playarr/shared';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { AudioEngine } from './AudioEngine';
import { playTracker } from './playTracker';
import { currentTrack, usePlayer } from './store';

vi.mock('./loadAhead', () => ({ useLoadAhead: () => {} }));
vi.mock('./playTracker', () => ({ playTracker: { start: vi.fn(), finish: vi.fn(), tick: vi.fn(), pause: vi.fn() } }));

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
  usePrefs.setState({ crossfade: 0, levelVolume: true, autoplay: false });
  usePlayer.setState({ repeat: 'off', volume: 1, muted: false });
});

afterEach(() => {
  cleanup();
  blocked.clear();
  vi.clearAllMocks();
});

const song = (id: number, albumId = id) =>
  ({ id, fileId: id, recordingId: `r${id}`, albumId, discNumber: 1, trackNumber: 1, duration: 200, title: `Song ${id}`, streamUrl: `/stream/${id}` }) as Track;

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

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
  return [...container.querySelectorAll('audio')] as [HTMLAudioElement, HTMLAudioElement];
}

const src = (deck: HTMLAudioElement) => deck.getAttribute('src');
const now = () => currentTrack(usePlayer.getState())?.fileId;

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
    usePrefs.setState({ crossfade: 6 });
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

  it('never fades between songs of one album played in order', async () => {
    usePrefs.setState({ crossfade: 6 });
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

  it('turns loud songs down', async () => {
    vi.spyOn(api, 'levels').mockResolvedValue({ r41: { track: -6 } });
    const [a] = await start([song(41), song(42)]);
    expect(fake(a).volume).toBeCloseTo(10 ** (-6 / 20), 2);
    usePrefs.getState().setLevelVolume(false);
    await settle();
    expect(fake(a).volume).toBe(1);
  });
});
