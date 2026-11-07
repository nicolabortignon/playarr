import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefs } from '../lib/prefs';
import { playQuality } from '../lib/quality';
import { canSetVolume, type QueueState } from './decks';
import { useLevels } from './levels';
import { useOffline } from './offline';
import { chooseStream, encodedStreamFailed, streamsEncoded } from './streams';

// iPhones fix the volume, and only desktops play through Web Audio: the tests say which they are.
vi.mock('./decks', async (importOriginal) => ({ ...(await importOriginal<typeof import('./decks')>()), canSetVolume: vi.fn(() => true), isDesktop: vi.fn(() => true) }));

const flac = (id: number) =>
  ({
    id,
    fileId: id,
    recordingId: `r${id}`,
    duration: 200,
    size: 22_500_000,
    streamUrl: `/stream/${id}`,
    format: { codec: 'FLAC', container: 'flac', lossless: true },
  }) as Track;
const queue = (t: Track): QueueState => ({ queue: [t], order: [0], pos: 0, repeat: 'off' });

/** A desktop browser that can play elements through Web Audio. */
function webAudio() {
  function FakeContext() {}
  Object.assign(FakeContext.prototype, { createMediaElementSource() {} });
  vi.stubGlobal('AudioContext', FakeContext);
}

beforeEach(() => {
  vi.mocked(canSetVolume).mockReturnValue(true);
  usePrefs.setState({ wifiQuality: 'original', cellularQuality: 'normal', transitions: 'off', levelVolume: true });
  useLevels.setState({ levels: {} });
  useOffline.setState({ songs: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('where a song plays from', () => {
  it('streams its own file at Original, and its encoded stream at High and Normal, from the sample asked for', () => {
    const t = flac(1);
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/1', offset: 0 });
    usePrefs.setState({ wifiQuality: 'normal' });
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/1/aac?kbps=128', offset: 0, encoded: 128 });
    expect(chooseStream(t, queue(t), 61.25)).toEqual({ url: `/stream/1/aac?kbps=128&start=${61.25 * 44_100}`, offset: 61.25, encoded: 128 });
    expect(streamsEncoded(t, queue(t))).toBe(true);
  });

  it('levels it in the stream where nothing else can (an iPhone): uncompressed at Original, encoded at High and Normal', () => {
    vi.mocked(canSetVolume).mockReturnValue(false);
    const t = flac(2);
    useLevels.setState({ levels: { r2: { track: -4.5 } } });
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/2/levelled.wav?gain=-4.5', offset: 0, baked: -4.5 });
    usePrefs.setState({ wifiQuality: 'high' });
    expect(chooseStream(t, queue(t), 10)).toEqual({ url: '/stream/2/levelled.aac?gain=-4.5&kbps=256&start=441000', offset: 10, encoded: 256, baked: -4.5 });
  });

  it('levels it by its gain in Web Audio on a desktop, from its own file or its encoded stream, never a levelled one', () => {
    webAudio();
    const t = flac(3);
    useLevels.setState({ levels: { r3: { track: 5 } } });
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/3', offset: 0, graph: 5 });
    usePrefs.setState({ wifiQuality: 'normal' });
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/3/aac?kbps=128', offset: 0, encoded: 128, graph: 5 });
    usePrefs.setState({ levelVolume: false });
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/3/aac?kbps=128', offset: 0, encoded: 128 });
  });

  it('plays a copy kept on this device as good as the quality wanted, leveled like a streamed one; offline any copy', () => {
    webAudio();
    const t = flac(4);
    useLevels.setState({ levels: { r4: { track: -2 } } });
    useOffline.setState({ songs: { 4: { url: '/stream/4/aac?kbps=128', bytes: 1, usedAt: 0 } } });
    usePrefs.setState({ wifiQuality: 'normal' });
    expect(chooseStream(t, queue(t), 30)).toEqual({ url: '/stream/4/aac?kbps=128', offset: 0, graph: -2 });
    expect(streamsEncoded(t, queue(t))).toBe(false);
    usePrefs.setState({ wifiQuality: 'high' });
    expect(chooseStream(t, queue(t)).url).toBe('/stream/4/aac?kbps=256');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(chooseStream(t, queue(t)).url).toBe('/stream/4/aac?kbps=128');
  });

  it('streams a song leveled on a phone while its copy on the device is below the quality wanted, and plays that copy offline', () => {
    vi.mocked(canSetVolume).mockReturnValue(false);
    const t = flac(7);
    useLevels.setState({ levels: { r7: { track: -3 } } });
    useOffline.setState({ songs: { 7: { url: '/stream/7/aac?kbps=128', bytes: 1, usedAt: 0 } } });
    usePrefs.setState({ wifiQuality: 'high' });
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/7/levelled.aac?gain=-3&kbps=256', offset: 0, encoded: 256, baked: -3 });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(chooseStream(t, queue(t))).toEqual({ url: '/stream/7/aac?kbps=128', offset: 0 });
  });

  it('plays its own file once its encoded stream has failed', () => {
    const t = flac(5);
    usePrefs.setState({ wifiQuality: 'normal' });
    encodedStreamFailed(t);
    expect(chooseStream(t, queue(t), 30)).toEqual({ url: '/stream/5', offset: 0 });
  });
});

describe('DJ mix', () => {
  it('plays songs’ own files outside WebKit, where an encoded stream isn’t known to line up with its transitions', () => {
    usePrefs.setState({ wifiQuality: 'normal', transitions: 'dj' });
    expect(playQuality()).toBe('original');
    expect(playQuality('high')).toBe('original');
    usePrefs.setState({ transitions: 'crossfade' });
    expect(playQuality()).toBe('normal');
  });

  it('streams encoded in WebKit, where it lines up to the sample', () => {
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    usePrefs.setState({ wifiQuality: 'normal', transitions: 'dj' });
    expect(playQuality()).toBe('normal');
    const t = flac(6);
    expect(chooseStream(t, queue(t)).url).toBe('/stream/6/aac?kbps=128');
  });
});
