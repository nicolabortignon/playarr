import { RENDER_RATE, type CuePoints, type MixMap } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { canSetVolume } from './decks';
import {
  canLiveMix,
  contextTimeFor,
  type LiveMix,
  outputTime,
  playLiveMix,
  prepareLiveMix,
  PREPARE_BUDGET_MS,
  withDeadline,
} from './liveMix';
import { answerLiveMix, type LiveMixRequest } from './liveMix.worker';
import { useOffline } from './offline';

vi.mock('../lib/api', () => ({ api: { mixMaps: vi.fn() } }));
vi.mock('./decks', async (original) => ({ ...(await original<typeof import('./decks')>()), canSetVolume: vi.fn(() => true) }));

type Song = MixMap & { cues?: CuePoints };

const map = (overrides: Partial<Song> = {}): Song => ({
  version: 1,
  duration: 300,
  bpm: 124,
  firstBeat: 0.5,
  downbeatOffset: 0,
  gridStable: true,
  beatConfidence: 0.9,
  key: { camelot: '8A', confidence: 0.8 },
  introEnd: 0.5 + (40 * 60) / 124,
  outroStart: 270,
  coldStart: false,
  coldEnd: false,
  soundEnd: 290,
  phraseEnergy: [],
  ...overrides,
});

describe('song time to Web Audio time', () => {
  const stamped = (contextTime: number, performanceTime: number, currentTime = 99) => ({
    currentTime,
    getOutputTimestamp: () => ({ contextTime, performanceTime }),
  });

  it('reads the output clock: what’s heard now, moved on by the time since it was stamped', () => {
    expect(outputTime(stamped(10, 1000), 1100)).toBeCloseTo(10.1);
  });

  it('falls back to currentTime without a timestamp, or before the output runs (all zeros)', () => {
    expect(outputTime({ currentTime: 7 }, 1100)).toBe(7);
    expect(outputTime(stamped(0, 0, 7), 1100)).toBe(7);
  });

  it('puts a time in A ahead of where A is by as long as A takes to get there', () => {
    const a = { currentTime: 50, playbackRate: 1 };
    expect(contextTimeFor(52, a, stamped(10, 1000), 1100)).toBeCloseTo(12.1);
    expect(contextTimeFor(52, a, { currentTime: 7 }, 1100)).toBeCloseTo(9);
  });

  it('follows A’s playback rate', () => {
    expect(contextTimeFor(52, { currentTime: 50, playbackRate: 2 }, { currentTime: 7 })).toBeCloseTo(8);
  });
});

describe('withDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is the work’s answer when it comes in time', async () => {
    let seen: AbortSignal | undefined;
    const answer = withDeadline(async (signal) => {
      seen = signal;
      return 'mixed';
    }, 1500);
    await expect(answer).resolves.toBe('mixed');
    expect(seen?.aborted).toBe(true); // nothing left to run: cleaned up
  });

  it('is null when time runs out, and the work is told to stop', async () => {
    let seen: AbortSignal | undefined;
    const answer = withDeadline((signal) => {
      seen = signal;
      return new Promise<string>(() => {});
    }, 1500);
    await vi.advanceTimersByTimeAsync(1499);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBeNull();
    expect(seen?.aborted).toBe(true);
  });

  it('is null when the caller gives up (a second skip), and the work is told to stop', async () => {
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const answer = withDeadline(
      (signal) => {
        seen = signal;
        return new Promise<string>(() => {});
      },
      1500,
      caller.signal,
    );
    caller.abort();
    await expect(answer).resolves.toBeNull();
    expect(seen?.aborted).toBe(true);
  });

  it('is null when the work fails, or the caller had already given up', async () => {
    await expect(withDeadline(() => Promise.reject(new Error('decode failed')), 1500)).resolves.toBeNull();
    const work = vi.fn(async () => 'mixed');
    await expect(withDeadline(work, 1500, AbortSignal.abort())).resolves.toBeNull();
    expect(work).not.toHaveBeenCalled();
  });
});

describe('canLiveMix', () => {
  const pointer = (fine: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: fine)' && fine }));

  beforeEach(() => {
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('OfflineAudioContext', class {});
    vi.stubGlobal('Worker', class {});
    pointer(true);
    vi.mocked(canSetVolume).mockReturnValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('on a desktop browser', () => {
    expect(canLiveMix()).toBe(true);
  });

  it('not with a touch screen as the only pointer (phones, tablets)', () => {
    pointer(false);
    expect(canLiveMix()).toBe(false);
  });

  it('not where the volume is fixed (iPads with a trackpad)', () => {
    vi.mocked(canSetVolume).mockReturnValue(false);
    expect(canLiveMix()).toBe(false);
  });

  it.each(['AudioContext', 'OfflineAudioContext', 'Worker'])('not without %s', (name) => {
    vi.stubGlobal(name, undefined);
    expect(canLiveMix()).toBe(false);
  });
});

describe('prepareLiveMix', () => {
  const MB = 1024 ** 2;
  const track = (id: number, overrides: Partial<Track> = {}): Track =>
    ({
      id,
      fileId: id,
      recordingId: `rec-${id}`,
      albumId: id,
      trackNumber: 1,
      discNumber: 1,
      duration: 300,
      size: 10 * MB,
      streamUrl: `/stream/${id}`,
      format: { codec: 'MP3', container: 'mp3', lossless: false },
      ...overrides,
    }) as Track;

  /** Every song decodes to this many seconds of quiet noise. */
  const DECODED_SECONDS = 90;
  class FakeAudioBuffer {
    numberOfChannels = 2;
    sampleRate = RENDER_RATE;
    length: number;
    channels: Float32Array[];
    constructor({ length }: { length: number }) {
      this.length = length;
      this.channels = [new Float32Array(length), new Float32Array(length)];
    }
    get duration() {
      return this.length / this.sampleRate;
    }
    copyFromChannel(into: Float32Array, channel: number, from: number) {
      into.set(this.channels[channel]!.subarray(from, from + into.length));
    }
    copyToChannel(from: Float32Array, channel: number) {
      this.channels[channel]!.set(from);
    }
  }
  const decoded = new FakeAudioBuffer({ length: DECODED_SECONDS * RENDER_RATE });
  decoded.channels.forEach((channel) => channel.forEach((_, i) => (channel[i] = 0.1 * Math.sin(i * 0.37))));

  /** Runs the real worker code, without a worker. */
  class FakeWorker {
    static requests: LiveMixRequest[] = [];
    static terminated = 0;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    postMessage(request: LiveMixRequest) {
      FakeWorker.requests.push(request);
      setTimeout(() => this.onmessage?.({ data: answerLiveMix(request).reply }));
    }
    terminate() {
      FakeWorker.terminated++;
    }
  }

  let fetches: { url: string; range: string | null; signal: AbortSignal }[];
  let respond: (url: string, signal: AbortSignal) => Promise<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetches = [];
    respond = async () => new Response(new ArrayBuffer(16), { status: 200 });
    FakeWorker.requests = [];
    FakeWorker.terminated = 0;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      fetches.push({ url, range: new Headers(init.headers).get('Range'), signal: init.signal! });
      return respond(url, init.signal!);
    });
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = async () => decoded;
      },
    );
    vi.stubGlobal('AudioBuffer', FakeAudioBuffer);
    vi.stubGlobal('Worker', FakeWorker);
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map(), 'rec-2': map() });
    useOffline.setState({ songs: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const prepare = (a = track(1), b = track(2), signal = new AbortController().signal) =>
    prepareLiveMix({ a, b, aPosition: 60, mode: 'auto', signal });

  it('renders a quick mix from A no earlier than the time it takes to prepare', async () => {
    const mix = await prepare();
    expect(mix).not.toBeNull();
    const { plan, buffer } = mix!;
    expect(plan.style).toBe('quick');
    expect(plan.aStart).toBeGreaterThanOrEqual(60 + PREPARE_BUDGET_MS / 1000);
    expect(buffer.length).toBe(Math.round(plan.length * RENDER_RATE));
    expect(buffer.sampleRate).toBe(RENDER_RATE);
    expect(mix!.from.fileId).toBe(1);
    expect(mix!.to.fileId).toBe(2);
    expect(api.mixMaps).toHaveBeenCalledWith(['rec-1', 'rec-2']);
    expect(FakeWorker.terminated).toBe(1);
  });

  it('decodes all of A, but only B’s start: a byte range where the format allows', async () => {
    await prepare();
    expect(fetches.find((f) => f.url === '/stream/1')?.range).toBeNull();
    expect(fetches.find((f) => f.url === '/stream/2')?.range).toMatch(/^bytes=0-\d+$/);
    // Songs go to the worker cut down to around the mix, not whole.
    const [request] = FakeWorker.requests;
    expect(request!.aAudio.start).toBeGreaterThan(60);
    expect(request!.aAudio.start).toBeLessThanOrEqual(request!.at);
    expect(request!.aAudio.left.length / RENDER_RATE).toBeLessThan(8); // 12 beats at 124 BPM, and margins
    expect(request!.bAudio.start).toBe(0);
  });

  it('fetches all of B when its format can’t be decoded from a part', async () => {
    await prepare(track(1), track(2, { format: { codec: 'AAC', container: 'm4a', lossless: false } }));
    expect(fetches.find((f) => f.url === '/stream/2')?.range).toBeNull();
  });

  it('plays a song kept on this device from the cache', async () => {
    useOffline.setState({ songs: { 2: { url: '/stream/2', bytes: 10 * MB, usedAt: 0 } } });
    const match = vi.fn(async () => new Response(new ArrayBuffer(16)));
    vi.stubGlobal('caches', { match });
    expect(await prepare()).not.toBeNull();
    expect(match).toHaveBeenCalledWith('/stream/2', { cacheName: 'playarr-audio' });
    expect(fetches.map((f) => f.url)).toEqual(['/stream/1']);
  });

  it.each([
    ['no mix map for B', () => vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map() })],
    ['A too big to decode whole', () => {}, track(1, { size: 80 * MB })],
    ['the stream fails', () => (respond = async () => new Response('', { status: 500 }))],
    [
      'no sure beat and an abrupt start to B (straight on)',
      () => vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ beatConfidence: 0.1 }), 'rec-2': map({ coldStart: true }) }),
    ],
  ])('%s: null, for an immediate switch', async (_, setUp, a = track(1)) => {
    setUp();
    expect(await prepare(a)).toBeNull();
  });

  it('no beat in A: a short crossfade, from a few seconds of A', async () => {
    vi.mocked(api.mixMaps).mockResolvedValue({ 'rec-1': map({ bpm: 0, beatConfidence: 0 }), 'rec-2': map() });
    const mix = await prepare();
    const { at } = FakeWorker.requests[0]!;
    expect(at).toBeGreaterThanOrEqual(60 + PREPARE_BUDGET_MS / 1000);
    expect(mix?.plan).toMatchObject({ style: 'fade', aStart: at, length: 2.5 });
    expect(FakeWorker.requests[0]!.aAudio.left.length / RENDER_RATE).toBeCloseTo(4.5, 1);
  });

  it('no mixing on the queue, or the same file: null without asking anything', async () => {
    expect(await prepareLiveMix({ a: track(1), b: track(2), aPosition: 60, mode: 'off', signal: new AbortController().signal })).toBeNull();
    expect(await prepare(track(1), track(1))).toBeNull();
    expect(api.mixMaps).not.toHaveBeenCalled();
  });

  it('gives up after the time budget: null, and the downloads still running are stopped', async () => {
    vi.useFakeTimers();
    respond = (_, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const mix = prepare();
    await vi.advanceTimersByTimeAsync(PREPARE_BUDGET_MS);
    await expect(mix).resolves.toBeNull();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((f) => f.signal.aborted)).toBe(true);
  });

  it('a skip elsewhere meanwhile (the caller’s abort): null', async () => {
    const caller = new AbortController();
    respond = (_, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const mix = prepare(track(1), track(2), caller.signal);
    await vi.waitFor(() => expect(fetches.length).toBe(2));
    caller.abort();
    await expect(mix).resolves.toBeNull();
    expect(fetches.every((f) => f.signal.aborted)).toBe(true);
  });
});

describe('playLiveMix', () => {
  /** An audio context whose clock is the (fake) wall clock, from 0; no output timestamp, so currentTime is the clock. */
  function fakeContext(state: AudioContextState = 'running') {
    const t0 = Date.now();
    const source = { buffer: null as unknown, connect: vi.fn((node: unknown) => node), start: vi.fn(), stop: vi.fn() };
    const gain = () => ({
      gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn((node: unknown) => node),
      disconnect: vi.fn(),
    });
    const gains: ReturnType<typeof gain>[] = [];
    const context = {
      state,
      destination: {},
      get currentTime() {
        return (Date.now() - t0) / 1000;
      },
      createBufferSource: () => source,
      createGain: () => {
        gains.push(gain());
        return gains.at(-1)!;
      },
    };
    return { context: context as unknown as AudioContext, source, gains };
  }
  const element = (currentTime: number, paused = false) =>
    ({ currentTime, playbackRate: 1, paused, pause: vi.fn(), play: vi.fn(() => Promise.resolve()) }) as unknown as HTMLMediaElement & {
      pause: ReturnType<typeof vi.fn>;
      play: ReturnType<typeof vi.fn>;
    };
  /** A 5-second mix from A at 52 s, into B at 30 s. */
  const mix = { plan: { aStart: 52, bResume: 30 }, buffer: { duration: 5 } } as unknown as LiveMix;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the mix when A reaches the mix point, pauses A then, and starts B from where the mix ends', async () => {
    const { context, source, gains } = fakeContext();
    const a = element(50);
    const b = element(0, true);
    const onStarted = vi.fn();
    const onLanded = vi.fn();
    const playback = playLiveMix(mix, { a, b, context, volume: 0.5, onStarted, onLanded })!;
    expect(playback.startsAt).toBeCloseTo(2);
    expect(source.start).toHaveBeenCalledWith(playback.startsAt);
    expect(b.currentTime).toBe(30);
    expect(gains[1]!.gain.value).toBe(0.5);

    await vi.advanceTimersByTimeAsync(1990);
    expect(a.pause).not.toHaveBeenCalled();
    expect(playback.time()).toBeCloseTo(-0.01);
    await vi.advanceTimersByTimeAsync(20);
    expect(a.pause).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();

    // B's element starts a moment before the mix ends, as it takes a moment to start.
    await vi.advanceTimersByTimeAsync(4900);
    expect(b.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(b.play).toHaveBeenCalledOnce();
    expect(onLanded).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('stopping cancels what’s still to come', async () => {
    const { context, source } = fakeContext();
    const a = element(50);
    const b = element(0, true);
    playLiveMix(mix, { a, b, context })!.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.stop).toHaveBeenCalled();
    expect(a.pause).not.toHaveBeenCalled();
    expect(b.play).not.toHaveBeenCalled();
  });

  it.each([
    ['A is past the mix point', element(52.01), 'running'],
    ['A is paused', element(50, true), 'running'],
    ['the context isn’t running', element(50), 'suspended'],
  ] as const)('%s: null, nothing played', (_, a, state) => {
    const { context, source } = fakeContext(state);
    expect(playLiveMix(mix, { a, b: element(0, true), context })).toBeNull();
    expect(source.start).not.toHaveBeenCalled();
  });
});
