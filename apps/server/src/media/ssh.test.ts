import type { SshHostKey } from '@playarr/shared';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newHostKey, startSshServer, type SshTestServer } from '../testing/sshServer.ts';
import { PCM_MAX_BUFFER } from './source.ts';
import { HostKeyChangedError, hostKeyOf, SshConnection, SshExecMediaSource, type SshOptions, SshShell } from './ssh.ts';

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

const servers: SshTestServer[] = [];
const connections: SshConnection[] = [];

async function server(opts: Partial<Parameters<typeof startSshServer>[0]> = {}) {
  const s = await startSshServer({ user: 'me', password: 'pw', ...opts });
  servers.push(s);
  return s;
}

function connect(s: SshTestServer, opts: Partial<SshOptions> = {}) {
  const conn = new SshConnection({ host: '127.0.0.1', port: s.port, username: 'me', password: 'pw', ...opts });
  connections.push(conn);
  return conn;
}

const passwordsSent = (s: SshTestServer) => s.logins.filter((l) => l.method === 'password').map((l) => l.password);

afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('host keys', () => {
  it('reads a key’s type and OpenSSH fingerprint, as ssh-keygen -l shows them', () => {
    const blob = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAINKnzcnBei8RHXseW9KMr5lVVnBOHob0Qz5FlDQoIawy', 'base64');
    expect(hostKeyOf(blob)).toEqual({ type: 'ssh-ed25519', fingerprint: 'SHA256:h+3V4ZaskOmtLieLZvA8MNwqXadWb5re2uTK9KWKIL8' });
  });

  it('trusts the first key on first use and reports it, once', async () => {
    const s = await server();
    const seen: SshHostKey[] = [];
    const conn = connect(s, { onHostKey: (key) => seen.push(key) });
    await conn.get();
    expect(seen).toEqual([{ type: 'ssh-ed25519', fingerprint: s.fingerprint }]);
    await conn.close();
    await conn.get(); // reconnecting to the same key isn't news
    expect(seen).toHaveLength(1);
    expect(passwordsSent(s)).toEqual(['pw', 'pw']);
  });

  it('refuses a key other than the trusted one before sending the password, naming both', async () => {
    const s = await server();
    const trusted = { type: 'ssh-ed25519', fingerprint: 'SHA256:h+3V4ZaskOmtLieLZvA8MNwqXadWb5re2uTK9KWKIL8' };
    const conn = connect(s, { hostKey: trusted, howToTrust: 'save it again' });
    const err = await conn.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostKeyChangedError);
    expect((err as Error).message).toBe(
      `The SSH host’s key has changed since Playarr first connected (it was ${trusted.fingerprint}, now ${s.fingerprint}). ` +
        'If you reinstalled or replaced that machine, save it again; if not, something may be pretending to be it.',
    );
    expect(s.connections).toBe(1);
    expect(s.logins).toEqual([]);
  });

  it('connects to the trusted key', async () => {
    const s = await server();
    const seen: SshHostKey[] = [];
    await connect(s, { hostKey: { type: 'ssh-ed25519', fingerprint: s.fingerprint }, onHostKey: (key) => seen.push(key) }).get();
    expect(seen).toEqual([]);
    expect(passwordsSent(s)).toEqual(['pw']);
  });

  it('trusts a new key when told to, and reports it', async () => {
    const s = await server();
    const seen: SshHostKey[] = [];
    const old = { type: 'ssh-ed25519', fingerprint: 'SHA256:h+3V4ZaskOmtLieLZvA8MNwqXadWb5re2uTK9KWKIL8' };
    await connect(s, { hostKey: old, trustNewHostKey: true, onHostKey: (key) => seen.push(key) }).get();
    expect(seen).toEqual([{ type: 'ssh-ed25519', fingerprint: s.fingerprint }]);
  });

  it('keeps to the key it first saw: a machine replaced at the same address is refused', async () => {
    const first = await server();
    const conn = connect(first);
    await conn.get();
    await conn.close();
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const replaced = await server({ port: first.port, hostKey: newHostKey() });
    await expect(conn.get()).rejects.toThrow(`it was ${first.fingerprint}, now ${replaced.fingerprint}`);
    expect(replaced.logins).toEqual([]);
  });
});
