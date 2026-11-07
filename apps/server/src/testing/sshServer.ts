import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';

export interface SshTestServer {
  port: number;
  /** The host key's OpenSSH fingerprint, worked out here from its public key as `ssh-keygen -l` does. */
  fingerprint: string;
  /** Every login attempt, with the password sent, if any. */
  logins: { username: string; method: string; password?: string }[];
  /** Connections opened, logged in or not. */
  connections: number;
  close(): Promise<void>;
}

/** A host key for `startSshServer`, in OpenSSH's format: one per machine, kept to start "the same machine" again. */
export const newHostKey = () => utils.generateKeyPairSync('ed25519');

/**
 * A real SSH server on 127.0.0.1 with its own host key: logs `user` in with `password` (or `authorizedKey`), and answers
 * `stat -L -c '%s %Y %F' -- '<dir>'` (what an SSH folder runs to check its folder) for each of `dirs`.
 */
export async function startSshServer(opts: {
  user: string;
  password: string;
  dirs?: string[];
  hostKey?: ReturnType<typeof newHostKey>;
  /** A public key (OpenSSH's one-line form) that logs `user` in too. */
  authorizedKey?: string;
  /** Listen here: a machine replaced at the same address. */
  port?: number;
}): Promise<SshTestServer> {
  const key = opts.hostKey ?? newHostKey();
  const blob = Buffer.from(key.public.split(' ')[1]!, 'base64');
  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  const authorized = opts.authorizedKey ? utils.parseKey(opts.authorizedKey) : undefined;
  if (authorized instanceof Error) throw authorized;
  const logins: SshTestServer['logins'] = [];
  const stats = new Map((opts.dirs ?? []).map((dir) => [`stat -L -c '%s %Y %F' -- '${dir}'`, '4096 1700000000 directory\n']));
  const state = { connections: 0 };
  const open = new Set<{ end(): unknown }>();
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    state.connections++;
    open.add(client);
    client.on('close', () => open.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      logins.push({ username: ctx.username, method: ctx.method, ...(ctx.method === 'password' ? { password: ctx.password } : {}) });
      if (ctx.username !== opts.user) return ctx.reject(['password', 'publickey']);
      if (ctx.method === 'password' && ctx.password === opts.password) return ctx.accept();
      if (ctx.method === 'publickey' && authorized && ctx.key.data.equals(authorized.getPublicSSH())) {
        // Asked first whether the key would do, then signed with it.
        if (!ctx.signature || authorized.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec();
          const out = stats.get(info.command);
          if (out) channel.write(out);
          else channel.stderr.write('No such file or directory\n');
          channel.exit(out ? 0 : 1);
          channel.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    fingerprint,
    logins,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const client of open) client.end();
      }),
  };
}
