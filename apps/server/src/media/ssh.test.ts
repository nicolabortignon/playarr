import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PCM_MAX_BUFFER } from './source.ts';
import { type SshConnection, SshExecMediaSource, SshShell } from './ssh.ts';

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

/** A connection whose commands start at once, each on the next of `channels`. */
function startingConnection(...channels: FakeChannel[]) {
  const client = { exec: (_command: string, cb: (err: Error | undefined, channel: FakeChannel) => void) => void queueMicrotask(() => cb(undefined, channels.shift()!)) };
  return { get: async () => client } as unknown as SshConnection;
}

/** The channel ends as a command on the host would: its exit code, then closed. */
function exit(channel: FakeChannel, code: number) {
  channel.closed = true;
  channel.emit('close', code);
}

describe('SshShell commands', () => {
  it('answers what a command wrote, and its error output when it fails', async () => {
    const ok = new FakeChannel();
    const failed = new FakeChannel();
    const shell = new SshShell(startingConnection(ok, failed));
    const answer = shell.run('stat -- /music/a.flac');
    await vi.waitFor(() => expect(ok.listenerCount('data')).toBe(1));
    ok.write('123 456\n');
    exit(ok, 0);
    expect(await answer).toBe('123 456\n');

    const refused = shell.run('stat -- /music/b.flac');
    await vi.waitFor(() => expect(failed.listenerCount('data')).toBe(1));
    failed.stderr.write('Could not chdir to home directory /home/x: No such file or directory\nstat: cannot stat: No such file\n');
    exit(failed, 1);
    await expect(refused).rejects.toThrow(/^stat: cannot stat: No such file$/);
  });

  it('stops a command that goes quiet, and one that says too much', async () => {
    const quiet = new FakeChannel();
    const chatty = new FakeChannel();
    const shell = new SshShell(startingConnection(quiet, chatty));
    const waited = shell.run('find /music', { quietMs: 50 });
    await vi.waitFor(() => expect(quiet.listenerCount('data')).toBe(1));
    quiet.write('a line\n');
    await expect(waited).rejects.toThrow('The SSH host stopped answering (nothing for 0.05 s)');
    expect(quiet.closed).toBe(true);

    const flooded = shell.runBuffer('cat -- /music/cover.jpg', { maxBytes: 1024 * 1024 });
    await vi.waitFor(() => expect(chatty.listenerCount('data')).toBe(1));
    chatty.write(Buffer.alloc(700 * 1024));
    chatty.write(Buffer.alloc(700 * 1024));
    await expect(flooded).rejects.toThrow('The SSH host’s answer was over 1 MB');
    expect(chatty.closed).toBe(true);
  });

  it('gives up on a host that doesn’t start a command, and closes it if it starts after all', async () => {
    const { conn, channel, start } = fakeConnection();
    const shell = new SshShell(conn, 30);
    await expect(shell.run('stat -- /music/a.flac')).rejects.toThrow('The SSH host didn’t start a command within 0.03 s');
    start();
    await vi.waitFor(() => expect(channel.closed).toBe(true));
  });

  it('stops a decode that hands back more audio than this server’s own ffmpeg may', async () => {
    const channel = new FakeChannel();
    const decoded = new SshExecMediaSource(startingConnection(channel)).pcm('/music/a.flac', { sampleRate: 44_100, maxSeconds: 30 });
    await vi.waitFor(() => expect(channel.listenerCount('data')).toBe(1));
    channel.write(Buffer.alloc(PCM_MAX_BUFFER + 1));
    await expect(decoded).rejects.toThrow(`ffmpeg: The SSH host’s answer was over ${PCM_MAX_BUFFER / 1024 / 1024} MB`);
    expect(channel.closed).toBe(true);
  });
});
