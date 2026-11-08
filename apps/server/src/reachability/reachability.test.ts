import type { ReachabilityCheck } from '@playarr/shared';
import Fastify from 'fastify';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverRoutes } from '../routes/server.ts';
import { fetchAt, ProbeError, type ProbeAnswer, type Resolved } from './probe.ts';
import { Reachability, type ReachabilityDeps } from './reachability.ts';
import { TEST_CERT, TEST_HOST, TEST_KEY } from './testCertificate.ts';

const HOME = 'https://music.example.com';
const PUBLIC: Resolved = { address: '203.0.113.7', family: 4 };
const PUBLIC6: Resolved = { address: '2001:db8::7', family: 6 };
const LETS_ENCRYPT = { issuer: 'Let’s Encrypt', validTo: '2027-02-05T12:00:00.000Z' };

const tokenOf = (url: URL) => url.pathname.split('/').at(-1)!;
const code = (name: string, phase: ProbeError['phase']) => new ProbeError(`${name} failure`, phase, name);

/**
 * A check of https://music.example.com, whose name has PUBLIC's address, and where by default this very server
 * answers: its own token route's answer.
 */
function checker(deps: Partial<ReachabilityDeps> = {}) {
  const fetch = vi.fn(
    deps.fetch ??
      (async (url: URL): Promise<ProbeAnswer> => ({ status: 200, body: JSON.stringify({ answer: reachability.answer(tokenOf(url)) }), certificate: LETS_ENCRYPT })),
  );
  const lookup = vi.fn(deps.lookup ?? (async (): Promise<Resolved[]> => [PUBLIC]));
  const reachability: Reachability = new Reachability({ publicUrl: HOME, ...deps, lookup, fetch });
  return { reachability, fetch, lookup };
}

/** Each step's status, by step. */
const statuses = (check: ReachabilityCheck) => Object.fromEntries(check.steps.map((s) => [s.id, s.status]));
const step = (check: ReachabilityCheck, id: string) => check.steps.find((s) => s.id === id)!;

describe('the reachability check', () => {
  it('passes when this very server answers at its public address over HTTPS', async () => {
    const { reachability, fetch, lookup } = checker();
    const check = await reachability.check();
    expect(check).toMatchObject({ verdict: 'reachable', publicUrl: HOME, summary: `Phones away from home can reach this server at ${HOME}.` });
    expect(statuses(check)).toEqual({ address: 'ok', dns: 'ok', connect: 'ok', certificate: 'ok', playarr: 'ok' });
    expect(step(check, 'dns').detail).toBe('music.example.com is 203.0.113.7.');
    expect(step(check, 'certificate').detail).toBe('From Let’s Encrypt, valid until February 5, 2027.');
    expect(check.steps.every((s) => !s.fix)).toBe(true);
    // It asked nothing of anyone else: its own name, at its own address, on its own token route.
    expect(lookup.mock.calls.map((c) => c[0])).toEqual(['music.example.com']);
    const [url, at] = fetch.mock.calls[0]!;
    expect([url.origin, url.pathname.replace(/[^/]+$/, ''), at]).toEqual([HOME, '/reachable/', PUBLIC]);
    // The token was good once, and is gone.
    expect(reachability.answer(tokenOf(url))).toBeUndefined();
  });

  it('says to set an https:// public address first', async () => {
    const unset = await new Reachability({}).check();
    expect(unset.verdict).toBe('unreachable');
    expect(statuses(unset)).toEqual({ address: 'fail', dns: 'skipped', connect: 'skipped', certificate: 'skipped', playarr: 'skipped' });
    expect(step(unset, 'address').fix).toMatch(/PLAYARR_DOMAIN/);
    expect(unset).not.toHaveProperty('publicUrl');

    const plain = await checker({ publicUrl: 'http://music.example.com' }).reachability.check();
    expect(step(plain, 'address')).toMatchObject({ status: 'fail', detail: 'http://music.example.com is plain http://.' });

    for (const home of ['https://192.168.1.103', 'https://nas.local', 'https://nas:4000']) {
      const check = await checker({ publicUrl: home }).reachability.check();
      expect(step(check, 'address').detail).toMatch(/is a home address/);
      expect(check.verdict).toBe('unreachable');
    }
  });

  it('says to add the DNS record when the name doesn’t resolve, and when the resolver is slow', async () => {
    const missing = await checker({ lookup: async () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })) }).reachability.check();
    expect(missing.verdict).toBe('unreachable');
    expect(step(missing, 'dns')).toMatchObject({ status: 'fail', detail: 'music.example.com doesn’t resolve from this server.' });
    expect(step(missing, 'dns').fix).toMatch(/add an A record for music\.example\.com/);
    expect(statuses(missing).connect).toBe('skipped');

    const slow = await checker({ lookup: async () => Promise.reject(Object.assign(new Error('slow'), { code: 'ETIMEOUT' })) }).reachability.check();
    expect(step(slow, 'dns').detail).toBe('Looking up music.example.com took more than 3 s.');
  });

  it('can’t confirm a name that leads to a home address, even when it all works from here', async () => {
    const { reachability } = checker({ lookup: async () => [{ address: '192.168.1.103', family: 4 }] });
    const check = await reachability.check();
    expect(statuses(check)).toEqual({ address: 'ok', dns: 'warn', connect: 'ok', certificate: 'ok', playarr: 'ok' });
    expect(check.verdict).toBe('unconfirmed');
    expect(step(check, 'dns').fix).toMatch(/phone on mobile data/);
  });

  it('blames no one when the router doesn’t loop back: try it from a phone on mobile data', async () => {
    const { reachability, fetch } = checker({
      lookup: async () => [PUBLIC, PUBLIC6],
      fetch: vi.fn(async (_url: URL, at: Resolved): Promise<ProbeAnswer> => {
        throw at.family === 4 ? code('ETIMEDOUT', 'connect') : code('ENETUNREACH', 'connect');
      }),
    });
    const check = await reachability.check();
    expect(check.verdict).toBe('unconfirmed');
    expect(check.summary).toBe(`This server couldn’t confirm it from inside your home: open ${HOME} on a phone on mobile data to be sure.`);
    expect(statuses(check)).toEqual({ address: 'ok', dns: 'ok', connect: 'fail', certificate: 'skipped', playarr: 'skipped' });
    // Both addresses tried, IPv4 first.
    expect(fetch.mock.calls.map((c) => c[1])).toEqual([PUBLIC, PUBLIC6]);
    expect(step(check, 'connect').detail).toBe(
      'No answer from 203.0.113.7 on port 443 within 5 s. [2001:db8::7] can’t be reached from this server (no route).',
    );
    expect(step(check, 'connect').fix).toMatch(/hairpin NAT/);
    expect(step(check, 'connect').fix).toMatch(/forwards ports 80 and 443/);
    expect(step(check, 'connect').fix).toMatch(/CGNAT/);
  });

  it('calls a refused connection at a home address what it is: nothing answers there', async () => {
    const { reachability } = checker({
      lookup: async () => [{ address: '192.168.1.103', family: 4 }],
      fetch: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    });
    const check = await reachability.check();
    expect(check.verdict).toBe('unreachable');
    expect(step(check, 'connect').detail).toBe('Nothing answers on port 443 at 192.168.1.103 (connection refused).');
    expect(step(check, 'connect').fix).toMatch(/Caddy is running/);
  });

  it('names what’s wrong with the certificate', async () => {
    const expired = await checker({ fetch: async () => Promise.reject(code('CERT_HAS_EXPIRED', 'tls')) }).reachability.check();
    expect(statuses(expired)).toMatchObject({ connect: 'ok', certificate: 'fail', playarr: 'skipped' });
    expect(step(expired, 'certificate').detail).toBe('The certificate has expired.');
    expect(step(expired, 'certificate').fix).toMatch(/docker compose logs playarr-caddy/);
    // At a public address it may be the router's own page answering from inside.
    expect(expired.verdict).toBe('unconfirmed');
    expect(step(expired, 'certificate').fix).toMatch(/routers answer their public address themselves/);

    const otherName = await checker({ fetch: async () => Promise.reject(Object.assign(new Error('altnames'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })) }).reachability.check();
    expect(step(otherName, 'certificate').detail).toBe('The certificate is for another name, not music.example.com.');

    // Caddy still waiting for its certificate is the owner's own Caddy: no doubt about who answered.
    const none = await checker({ fetch: async () => Promise.reject(code('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'tls')) }).reachability.check();
    expect(none.verdict).toBe('unreachable');
    expect(step(none, 'certificate').detail).toBe('What answers on that port has no certificate for music.example.com yet.');
  });

  it('tells another server from this one', async () => {
    // Another Playarr, with outstanding tokens of its own: ours means nothing to it.
    const other = new Reachability({ publicUrl: 'https://other.example.com' });
    const { reachability } = checker({
      fetch: async (url) => {
        const answer = other.answer(tokenOf(url));
        return answer ? { status: 200, body: JSON.stringify({ answer }) } : { status: 404, body: '{"error":"Not found"}', certificate: LETS_ENCRYPT };
      },
    });
    const check = await reachability.check();
    expect(check.verdict).toBe('unreachable');
    expect(statuses(check)).toEqual({ address: 'ok', dns: 'ok', connect: 'ok', certificate: 'ok', playarr: 'fail' });
    expect(step(check, 'playarr').detail).toBe(`Something answered at ${HOME} (HTTP 404), but not this server.`);

    // A page that answers every path, with the wrong answer or none.
    for (const body of ['<!doctype html><title>Router</title>', '{"answer":"guess"}']) {
      const page = await checker({ fetch: async () => ({ status: 200, body }) }).reachability.check();
      expect(step(page, 'playarr').status).toBe('fail');
    }
  });

  it('says when the proxy is up but can’t reach Playarr, or redirects', async () => {
    const gateway = await checker({ fetch: async () => ({ status: 502, body: '' }) }).reachability.check();
    expect(step(gateway, 'playarr').detail).toBe('The proxy answered (HTTP 502) but couldn’t reach Playarr.');
    expect(step(gateway, 'playarr').fix).toMatch(/playarr:4000/);

    const redirect = await checker({ fetch: async () => ({ status: 302, body: '', location: 'https://login.example/' }) }).reachability.check();
    expect(step(redirect, 'playarr').detail).toBe(`${HOME} answered with a redirect to https://login.example/, not as this server.`);
  });

  it('gives Tailscale’s advice for a ts.net address', async () => {
    const tailnet = 'https://nas.tail1234.ts.net';
    const offTailnet = await checker({ publicUrl: tailnet, lookup: async () => [] }).reachability.check();
    expect(offTailnet.verdict).toBe('unconfirmed');
    expect(offTailnet.summary).toMatch(/on a phone with Tailscale on/);
    expect(step(offTailnet, 'dns').fix).toMatch(/resolves only on your tailnet/);

    const fromDocker = await checker({
      publicUrl: tailnet,
      lookup: async () => [{ address: '100.101.102.103', family: 4 }],
      fetch: async () => Promise.reject(code('ETIMEDOUT', 'connect')),
    }).reachability.check();
    expect(fromDocker.verdict).toBe('unconfirmed');
    expect(step(fromDocker, 'connect').fix).toMatch(/tailscale serve status/);
  });

  it('runs one check at a time: asking again joins the one running', async () => {
    let release!: () => void;
    const { reachability, fetch } = checker({
      fetch: vi.fn(async (url: URL) => {
        await new Promise<void>((resolve) => (release = resolve));
        return { status: 200, body: JSON.stringify({ answer: reachability.answer(tokenOf(url)) }) };
      }),
    });
    const first = reachability.check();
    const second = reachability.check();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release();
    expect(await second).toBe(await first);
    expect((await first).verdict).toBe('reachable');
  });
});

describe('the token route’s tokens', () => {
  it('answers a token once, while its check runs, and nothing else', async () => {
    let seen: URL | undefined;
    const { reachability } = checker({
      fetch: async (url) => {
        seen = url;
        const answer = reachability.answer(tokenOf(url));
        // Asked again: already answered.
        expect(reachability.answer(tokenOf(url))).toBeUndefined();
        return { status: 200, body: JSON.stringify({ answer }) };
      },
    });
    expect(reachability.answer('made-up')).toBeUndefined();
    expect((await reachability.check()).verdict).toBe('reachable');
    expect(tokenOf(seen!)).toMatch(/^[\w-]{32}$/);
  });

  it('forgets a token when its check ends, answered or not', async () => {
    let token = '';
    const { reachability } = checker({
      fetch: async (url) => {
        token = tokenOf(url);
        throw code('ECONNREFUSED', 'connect');
      },
    });
    await reachability.check();
    expect(token).not.toBe('');
    expect(reachability.answer(token)).toBeUndefined();
  });

  it('limits each visitor to 30 a minute', () => {
    let now = 0;
    const reachability = new Reachability({ now: () => now });
    for (let i = 0; i < 30; i++) expect(reachability.allows('198.51.100.1')).toBe(true);
    expect(reachability.allows('198.51.100.1')).toBe(false);
    expect(reachability.allows('198.51.100.2')).toBe(true);
    now += 60_000;
    expect(reachability.allows('198.51.100.1')).toBe(true);
  });
});

describe('the whole check against a real HTTPS server', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('reaches this Playarr’s token route over HTTPS, through its routes', async () => {
    // The server's own routes behind a TLS listener, as Caddy would put them.
    const app = Fastify();
    let reachability!: Reachability;
    serverRoutes(app, { info: () => ({ id: 'id', name: 'Playarr', version: '0', minAppVersion: '1.0.0', setup: false }), reachability: { answer: (t) => reachability.answer(t), allows: (v) => reachability.allows(v) } });
    await app.ready();
    server = createServer({ cert: TEST_CERT, key: TEST_KEY }, (req, res) => app.routing(req, res));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    reachability = new Reachability({
      publicUrl: `https://${TEST_HOST}:${port}`,
      // music.example.test is this machine; the test certificate stands in for Let's Encrypt.
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      fetch: (url, at, timeoutMs) => fetchAt(url, at, timeoutMs, { ca: TEST_CERT }),
    });
    const check = await reachability.check();
    expect(statuses(check)).toEqual({ address: 'ok', dns: 'warn', connect: 'ok', certificate: 'ok', playarr: 'ok' });
    expect(step(check, 'connect').detail).toBe(`Connected to 127.0.0.1 on port ${port}.`);
    expect(step(check, 'certificate').detail).toMatch(/^From Playarr Test, valid until .* 2126\.$/);
    // Reached at a home address, so not proven from outside.
    expect(check.verdict).toBe('unconfirmed');
    await app.close();
  });
});
