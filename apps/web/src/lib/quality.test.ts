import type { Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atLeast,
  encodedOffset,
  encodedUrl,
  encodes,
  isAppleWebKit,
  keptUrl,
  metered,
  qualityOfUrl,
  sizeAt,
  streamQuality,
  tellsMobileData,
} from './quality';

const song = (format: Partial<Track['format']>, size = 22_500_000, duration = 200) =>
  ({ streamUrl: '/stream/7', size, duration, format: { codec: 'FLAC', container: 'flac', lossless: true, ...format } }) as Track;
const flac = song({});
const mp3 = (kbps: number) => song({ codec: 'MP3', container: 'mp3', lossless: false, bitrate: kbps }, kbps * 25_000);

/** The browser says this about its connection (Chrome on Android); others say nothing. */
function connection(info: { type?: string; saveData?: boolean } | undefined) {
  Object.defineProperty(navigator, 'connection', { configurable: true, value: info && Object.assign(new EventTarget(), info) });
}

afterEach(() => {
  delete (navigator as { connection?: unknown }).connection;
  vi.restoreAllMocks();
});

describe('stream quality', () => {
  it('encodes a song at High and Normal, from its own file at Original', () => {
    expect(encodes(flac, 'high')).toBe(true);
    expect(encodes(flac, 'normal')).toBe(true);
    expect(encodes(flac, 'original')).toBe(false);
  });

  it('plays a file already about the quality’s size as it is: encoding it again would only lose quality', () => {
    expect(encodes(mp3(160), 'normal')).toBe(false);
    expect(encodes(mp3(192), 'normal')).toBe(true);
    expect(encodes(mp3(320), 'high')).toBe(false);
    // Without a bitrate, its size says.
    expect(encodes(song({ codec: 'AAC', container: 'm4a', lossless: false }, 4_000_000), 'normal')).toBe(false);
    // Neither known: encoded.
    expect(encodes(song({}, 0), 'normal')).toBe(true);
  });

  it('never encodes what the server doesn’t stream as a song (a transition)', () => {
    expect(encodes({ ...flac, streamUrl: '/transitions/abc.flac' }, 'normal')).toBe(false);
  });

  it('asks for the encoded stream from a sample, and levelled when a gain is given', () => {
    expect(encodedUrl(flac, 128)).toBe('/stream/7/aac?kbps=128');
    expect(encodedUrl(flac, 256, { start: 95.5 })).toBe(`/stream/7/aac?kbps=256&start=${95.5 * 44_100}`);
    expect(encodedUrl(flac, 128, { start: 1 / 3 })).toBe('/stream/7/aac?kbps=128&start=14700');
    expect(encodedUrl(flac, 128, { gainDb: -6.5 })).toBe('/stream/7/levelled.aac?gain=-6.5&kbps=128');
    expect(encodedUrl(flac, 128, { start: 2, gainDb: 0 })).toBe('/stream/7/levelled.aac?gain=0&kbps=128&start=88200');
  });

  it('places a stream asked for from a time at the sample it starts on', () => {
    expect(encodedOffset(95.5)).toBe(95.5);
    expect(encodedOffset(10.00001)).toBe(441_000 / 44_100);
    expect(encodedOffset(1e-6)).toBe(0);
  });

  it('knows a kept copy’s quality by its address', () => {
    expect(qualityOfUrl('/stream/7/aac?kbps=256')).toBe('high');
    expect(qualityOfUrl('/stream/7/aac?kbps=128')).toBe('normal');
    expect(qualityOfUrl('/stream/7')).toBe('original');
    expect(qualityOfUrl('/stream/7/lossless.wav')).toBe('original');
  });

  it('keeps a song as its encoded stream, or as its own file, and counts what each takes', () => {
    expect(keptUrl(flac, 'normal')).toBe('/stream/7/aac?kbps=128');
    expect(keptUrl(flac, 'original')).toBe('/stream/7');
    expect(keptUrl(mp3(160), 'normal')).toBe('/stream/7');
    expect(sizeAt(flac, 'original')).toBe(22_500_000);
    expect(sizeAt(mp3(160), 'normal')).toBe(4_000_000);
    // At most what the server declares: its bitrate, 20% over, and 16 KiB.
    expect(sizeAt(flac, 'normal')).toBe(200 * 16_000 * 1.2 + 16_384);
    expect(sizeAt(flac, 'high')).toBe(200 * 32_000 * 1.2 + 16_384);
  });

  it('ranks Original over High over Normal', () => {
    expect(atLeast('original', 'high')).toBe(true);
    expect(atLeast('high', 'high')).toBe(true);
    expect(atLeast('normal', 'high')).toBe(false);
    expect(atLeast('high', 'original')).toBe(false);
  });
});

describe('the connection', () => {
  const prefs = { wifiQuality: 'original', cellularQuality: 'normal' } as const;

  it('streams at mobile data’s quality where the browser says it’s on mobile data, or saving data', () => {
    connection({ type: 'cellular' });
    expect([metered(), tellsMobileData(), streamQuality(prefs)]).toEqual([true, true, 'normal']);
    connection({ type: 'wifi', saveData: true });
    expect(streamQuality(prefs)).toBe('normal');
    connection({ type: 'wifi' });
    expect([metered(), streamQuality(prefs)]).toEqual([false, 'original']);
  });

  it('streams at Wi-Fi’s where the browser doesn’t say', () => {
    connection(undefined);
    expect([metered(), tellsMobileData(), streamQuality(prefs)]).toEqual([false, false, 'original']);
    // Chrome on a computer: Data Saver, but no type.
    connection({ saveData: false });
    expect([metered(), tellsMobileData()]).toEqual([false, false]);
  });

  it('knows WebKit by its vendor', () => {
    const vendor = vi.spyOn(navigator, 'vendor', 'get');
    vendor.mockReturnValue('Apple Computer, Inc.');
    expect(isAppleWebKit()).toBe(true);
    vendor.mockReturnValue('Google Inc.');
    expect(isAppleWebKit()).toBe(false);
    vendor.mockReturnValue('');
    expect(isAppleWebKit()).toBe(false);
  });
});
