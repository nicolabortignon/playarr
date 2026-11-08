import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';

/** How far a request got before it failed: the TCP connection, the TLS handshake (the certificate), or the answer. */
export type Phase = 'connect' | 'tls' | 'http';

/** A request that failed, with how far it got and the system's code (ECONNREFUSED, CERT_HAS_EXPIRED…). */
export class ProbeError extends Error {
  constructor(
    message: string,
    readonly phase: Phase,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** One of a name's addresses. */
export interface Resolved {
  address: string;
  family: 4 | 6;
}

/** What answered a GET: its status, the start of its body, where a redirect leads, and the certificate it showed. */
export interface ProbeAnswer {
  status: number;
  body: string;
  location?: string;
  certificate?: { issuer?: string; validTo?: string };
}

/** The most of a body read: the token route answers a few dozen bytes. */
const MAX_BODY = 4096;

/** A name's addresses, IPv4 first, from the server's own resolver; fails with code ETIMEOUT after `timeoutMs`. */
export async function resolveName(host: string, timeoutMs: number): Promise<Resolved[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${timeoutMs / 1000} s`), { code: 'ETIMEOUT' })), timeoutMs);
  });
  try {
    const found = await Promise.race([lookup(host, { all: true }), timeout]);
    return found.map(({ address, family }): Resolved => ({ address, family: family === 6 ? 6 : 4 })).sort((a, b) => a.family - b.family);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET `url` at one of its addresses: connecting there, with the URL's host for SNI, the certificate check and the
 * Host header, and the certificate checked against the system's authorities (`ca` replaces them, for tests). Fails
 * with a ProbeError saying how far it got, at the latest after `timeoutMs`. Nothing is sent anywhere else.
 */
export function fetchAt(url: URL, at: Resolved, timeoutMs: number, options: { ca?: string | Buffer } = {}): Promise<ProbeAnswer> {
  return new Promise((resolve, reject) => {
    let phase: Phase = 'connect';
    let settled = false;
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request({
      host: at.address,
      family: at.family,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // A connection of its own, closed after the answer: never one pooled for some other address.
      agent: false,
      // A name is what the certificate must be for; an address is checked as itself (SNI takes no addresses).
      ...(isIP(host) ? {} : { servername: host }),
      ...(options.ca ? { ca: options.ca } : {}),
      headers: { host: url.host, accept: 'application/json', connection: 'close', 'user-agent': 'Playarr reachability check' },
    });
    const timer = setTimeout(() => req.destroy(new ProbeError(`no answer within ${timeoutMs / 1000} s`, phase, 'ETIMEDOUT')), timeoutMs);
    req.on('socket', (socket) => {
      socket.once('connect', () => {
        if (phase === 'connect') phase = 'tls';
      });
      socket.once('secureConnect', () => {
        phase = 'http';
      });
    });
    req.on('response', (res) => {
      phase = 'http';
      const peer = (res.socket as TLSSocket).getPeerCertificate?.();
      // A field the certificate holds more than once comes as a list: the first is enough to name it.
      const name = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
      const issuer = peer?.issuer && (name(peer.issuer.O) || name(peer.issuer.CN));
      const until = peer?.valid_to ? new Date(peer.valid_to) : undefined;
      const location = res.headers.location;
      let body = '';
      const done = () =>
        settle(() =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            ...(location ? { location } : {}),
            certificate: { ...(issuer ? { issuer } : {}), ...(until && !Number.isNaN(until.getTime()) ? { validTo: until.toISOString() } : {}) },
          }),
        );
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body = (body + chunk).slice(0, MAX_BODY);
        if (body.length >= MAX_BODY) {
          done();
          res.destroy();
        }
      });
      res.on('end', done);
      res.on('error', (err: Error & { code?: string }) => settle(() => reject(new ProbeError(err.message, phase, err.code))));
    });
    req.on('error', (err: Error & { code?: string }) =>
      settle(() => reject(err instanceof ProbeError ? err : new ProbeError(err.message, phase, err.code))),
    );
    req.end();
  });
}
