import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { type SshConnection, SshExecMediaSource } from './ssh.ts';

/** An SSH channel stand-in: what ffmpeg on the host writes comes out of it, and it records being closed. */
class FakeChannel extends PassThrough {
  readonly stderr = new PassThrough();
  closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', null);
  }
}

/** A connection whose one command starts on the host once `start()` is called. */
function fakeConnection() {
  const channel = new FakeChannel();
  let start!: () => void;
  const started = new Promise<void>((resolve) => (start = resolve));
  const client = { exec: (_command: string, cb: (err: Error | undefined, channel: FakeChannel) => void) => void started.then(() => cb(undefined, channel)) };
  return { conn: { get: async () => client } as unknown as SshConnection, channel, start };
}

const ENCODE = { codec: 'aac', kbps: 128, skipSamples: 0, leadSamples: 1088, samples: 2000 } as const;

describe('SshExecMediaSource ffmpeg streams', () => {
  it('closes ffmpeg’s channel when the stream was closed before ffmpeg started on the host', async () => {
    const { conn, channel, start } = fakeConnection();
    const stream = new SshExecMediaSource(conn).encodedStream('/music/a.flac', ENCODE);
    stream.destroy();
    await new Promise((resolve) => stream.once('close', resolve));
    // The host answers later (it's over the network): the stream is long gone by then.
    start();
    await vi.waitFor(() => expect(channel.closed).toBe(true));
  });

  it('holds ffmpeg back while the stream’s reader is behind, lets it go on as they catch up, and stops it once they’ve gone', async () => {
    const { conn, channel, start } = fakeConnection();
    const stream = new SshExecMediaSource(conn).encodedStream('/music/a.flac', ENCODE);
    start();
    await vi.waitFor(() => expect(channel.listenerCount('data')).toBe(1));
    channel.write(Buffer.alloc(64 * 1024));
    await vi.waitFor(() => expect(channel.isPaused()).toBe(true));
    stream.resume();
    await vi.waitFor(() => expect(channel.isPaused()).toBe(false));
    expect(channel.closed).toBe(false);
    stream.destroy();
    await vi.waitFor(() => expect(channel.closed).toBe(true));
  });
});
