import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileResolver } from '../catalog/files.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import type { Library } from '../library/library.ts';
import type { MediaSource, PcmOptions } from '../media/source.ts';
import { LOUDNESS_RATE } from './loudness.ts';
import { LOUDNESS_VERSION, LoudnessJobs } from './loudnessJobs.ts';

/** `seconds` of a stereo 1 kHz sine at −23 dBFS (so −23 LUFS), as 16-bit PCM. */
function song(seconds: number): Buffer {
  const amplitude = 10 ** (-23 / 20);
  const frames = Math.round(seconds * LOUDNESS_RATE);
  const out = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * 1000 * i) / LOUDNESS_RATE) * 32767);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

const jobs: LoudnessJobs[] = [];
afterEach(() => jobs.splice(0).forEach((j) => j.close()));

/**
 * Loudness jobs over songs whose files hold `audio`, from a source that streams decodes (or, with
 * `stream: false`, only decodes sections).
 */
function setup(audio: Buffer, opts: { stream?: boolean; fail?: boolean } = {}) {
  const db = freshDb();
  const opened: string[] = [];
  const pcm = vi.fn(async (_path: string, o: PcmOptions) => {
    const from = Math.round((o.startSeconds ?? 0) * LOUDNESS_RATE) * 4;
    return audio.subarray(from, from + Math.round(o.maxSeconds * LOUDNESS_RATE) * 4);
  });
  const media: MediaSource = {
    kind: 'local',
    stat: async () => ({ size: 1234, mtimeMs: 5678 }),
    open: async () => Readable.from([]),
    check: async () => {},
    close: async () => {},
    pcm,
    ...(opts.stream === false
      ? {}
      : {
          pcmStream: (path: string) => {
            opened.push(path);
            if (opts.fail) return Readable.from((async function* () { throw new Error('ffmpeg: Invalid data found'); })());
            // In pieces that split frames, as a pipe does.
            return Readable.from([audio.subarray(0, 4097), audio.subarray(4097)]);
          },
        }),
  };
  const library = {
    trackByRecording: async (id: string) => ({ recordingId: id, fileId: id === 'b' ? 2 : 1 }),
    file: async (fileId: number) => ({ id: fileId, sourceId: 1, path: `/music/${fileId}.flac` }),
  } as unknown as Library;
  const files = { resolve: (file: { path: string }) => ({ media, path: file.path }) } as unknown as FileResolver;
  const warn = vi.fn();
  let redone = '';
  const loudness = new LoudnessJobs(db, library, files, { warn }, () => redone);
  jobs.push(loudness);
  const settle = () => vi.waitFor(() => expect(loudness.waiting + loudness.working).toBe(0), { timeout: 5000 });
  return { loudness, db, pcm, opened, warn, settle, redo: () => (redone = new Date().toISOString()) };
}

describe('LoudnessJobs', () => {
  it('measures a song from one streamed decode, and keeps which file it was measured from', async () => {
    const { loudness, settle, opened } = setup(song(10));
    expect(loudness.ensure(['a'])).toBe(1);
    await settle();
    expect(opened).toEqual(['/music/1.flac']);
    const measured = loudness.measured(['a', 'other']);
    expect([...measured.keys()]).toEqual(['a']);
    expect(measured.get('a')).toMatchObject({ fileId: 1, samples: 10 * LOUDNESS_RATE, size: 1234, mtimeMs: 5678 });
    expect(measured.get('a')!.lufs).toBeCloseTo(-23, 1);
    expect(measured.get('a')!.peak).toBeCloseTo(-23, 0);
    expect(loudness.ofFile(1)?.samples).toBe(10 * LOUDNESS_RATE);
    // Measured: not queued again.
    expect(loudness.ensure(['a'])).toBe(0);
  });

  it('decodes section by section, exactly, where the source can’t stream', async () => {
    const { loudness, settle, pcm } = setup(song(130), { stream: false });
    loudness.ensure(['a']);
    await settle();
    expect(pcm.mock.calls.map(([, o]) => [o.startSeconds, o.maxSeconds, o.exactSeek, o.channels, o.sampleRate])).toEqual([
      [0, 60, true, 2, LOUDNESS_RATE],
      [60, 60, true, 2, LOUDNESS_RATE],
      [120, 60, true, 2, LOUDNESS_RATE],
    ]);
    expect(loudness.measured(['a']).get('a')).toMatchObject({ samples: 130 * LOUDNESS_RATE });
  });

  it('measures songs about to play before the backlog', async () => {
    const { loudness, settle, opened } = setup(song(1));
    loudness.ensure(['x', 'a', 'c']); // x starts at once
    loudness.ensure(['b'], { urgent: true });
    await settle();
    expect(opened).toEqual(['/music/1.flac', '/music/2.flac', '/music/1.flac', '/music/1.flac']);
  });

  it('stores a failure, leaves it out of what’s measured, and doesn’t try again straight away', async () => {
    const { loudness, settle, db, warn } = setup(song(1), { fail: true });
    loudness.ensure(['a']);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loudness.measured(['a']).size).toBe(0);
    expect(db.prepare('SELECT error FROM track_loudness WHERE recording_id = ?').get('a')).toEqual({ error: 'ffmpeg: Invalid data found' });
    expect(loudness.ensure(['a'])).toBe(0);
    // A day later it's due again.
    db.prepare('UPDATE track_loudness SET analyzed_at = ?').run(new Date(Date.now() - 2 * 24 * 3600_000).toISOString());
    expect(loudness.ensure(['a'])).toBe(1);
  });

  it('measures every song again after Analyse all again or a new version, keeping the old levels meanwhile', async () => {
    const { loudness, settle, db, redo } = setup(song(1));
    loudness.ensure(['a']);
    await settle();
    redo();
    expect(loudness.ensure(['a'])).toBe(1);
    expect(loudness.measured(['a']).has('a')).toBe(true);
    await settle();
    db.prepare('UPDATE track_loudness SET version = ?').run(LOUDNESS_VERSION - 1);
    expect(loudness.ensure(['a'])).toBe(1);
  });

  it('measures a song whose file changed again, at once', async () => {
    const { loudness, settle, opened } = setup(song(1));
    loudness.ensure(['a']);
    await settle();
    loudness.remeasure('a');
    expect(loudness.measured(['a']).has('a')).toBe(false);
    await settle();
    expect(opened).toHaveLength(2);
    expect(loudness.measured(['a']).has('a')).toBe(true);
  });
});
