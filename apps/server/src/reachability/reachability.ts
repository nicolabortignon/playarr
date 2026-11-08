import type { ReachabilityCheck, ReachabilityStatus, ReachabilityStep, ReachabilityStepKind, ReachabilityVerdict } from '@playarr/shared';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { isLocalAddress, isLocalHost } from '../net.ts';
import { fetchAt, ProbeError, resolveName, type ProbeAnswer, type Resolved } from './probe.ts';

/** Where this server answers its own outstanding tokens: open, and outside /api/, as a visitor through the proxy has no session. */
export const REACHABLE_PATH = '/reachable';

const LOOKUP_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 5000;
/** A token lives only while its check runs, and never longer than this. */
const TOKEN_TTL_MS = 30_000;
/** Outstanding tokens kept at most (one check runs at a time, so one is usual). */
const MAX_TOKENS = 20;
/** The token route's limit: requests per visitor per minute, and visitors counted in a minute. */
const PER_VISITOR = 30;
const MAX_VISITORS = 10_000;

const ORDER: readonly ReachabilityStepKind[] = ['address', 'dns', 'connect', 'certificate', 'playarr'];

const LABELS: Record<ReachabilityStepKind, string> = {
  address: 'Public address',
  dns: 'Name lookup',
  connect: 'Connection',
  certificate: 'Certificate',
  playarr: 'This server answers',
};

/** What the check needs from the network: fakes in tests. */
export interface ReachabilityDeps {
  /** PUBLIC_URL (with PLAYARR_DOMAIN, https://<domain>). */
  publicUrl?: string;
  /** A name's addresses, IPv4 first; fails with code ETIMEOUT when the resolver is slow. */
  lookup?: (host: string, timeoutMs: number) => Promise<Resolved[]>;
  /** A GET at one of those addresses; fails with a ProbeError saying how far it got. */
  fetch?: (url: URL, at: Resolved, timeoutMs: number) => Promise<ProbeAnswer>;
  now?: () => number;
}

/**
 * Settings → Away from home: whether phones away from home reach this server at PUBLIC_URL over HTTPS. The server asks
 * its own public address the way a phone would, in steps: an https:// address, its name resolving, a connection, a
 * certificate the server accepts, and an answer only this server can give (GET /reachable/<token>, with a one-time
 * token it made for this check, whose answer it keeps to itself). Each step that fails says what to fix. Nothing goes
 * to anyone else: the only requests are the name's lookup and the server's own address.
 *
 * From inside the home that can fail where phones outside get through: many routers don't let a machine reach the
 * home's own public address (no hairpin NAT), and some answer it with their own page. The verdict says so
 * (unconfirmed) rather than calling the setup broken.
 */
export class Reachability {
  private readonly tokens = new Map<string, { answer: string; expires: number }>();
  private running?: Promise<ReachabilityCheck>;
  private window = -1;
  private readonly visitors = new Map<string, number>();

  constructor(private readonly deps: ReachabilityDeps = {}) {}

  /** Runs the check, or joins the one running: one at a time. */
  check(): Promise<ReachabilityCheck> {
    this.running ??= this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  /** GET /reachable/:token: the answer to one of this server's outstanding tokens, once; nothing for anything else. */
  answer(token: string): string | undefined {
    this.forgetExpired();
    const held = this.tokens.get(token);
    if (!held) return undefined;
    this.tokens.delete(token);
    return held.answer;
  }

  /** The token route's limit: true while `visitor` (an address) has asked fewer than 30 times this minute. */
  allows(visitor: string): boolean {
    const window = Math.floor(this.now() / 60_000);
    if (window !== this.window) {
      this.window = window;
      this.visitors.clear();
    }
    const count = this.visitors.get(visitor);
    // So many visitors this minute that a new one isn't counted: refused until the next minute.
    if (count === undefined && this.visitors.size >= MAX_VISITORS) return false;
    this.visitors.set(visitor, (count ?? 0) + 1);
    return (count ?? 0) < PER_VISITOR;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private forgetExpired() {
    const now = this.now();
    for (const [token, held] of this.tokens) if (held.expires <= now) this.tokens.delete(token);
  }

  /** A new token, and the answer only this server knows for it. */
  private issue(): { token: string; answer: string } {
    this.forgetExpired();
    while (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value!);
    const token = randomBytes(24).toString('base64url');
    const answer = randomBytes(24).toString('base64url');
    this.tokens.set(token, { answer, expires: this.now() + TOKEN_TTL_MS });
    return { token, answer };
  }

  private async run(): Promise<ReachabilityCheck> {
    const raw = this.deps.publicUrl;
    const report = new Report(raw, () => this.now());

    // 1. An https:// address the internet can reach.
    if (!raw) return report.fail('address', 'PUBLIC_URL isn’t set.', FIX.noAddress).unreachable();
    const url = new URL(raw);
    if (url.protocol !== 'https:') return report.fail('address', `${raw} is plain http://.`, FIX.notHttps).unreachable();
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    const port = Number(url.port || 443);
    if (isIP(host) ? isLocalAddress(host) : isLocalHost(host)) {
      return report.fail('address', `${host} is a home address: it works only at home.`, FIX.homeAddress).unreachable();
    }
    report.ok('address', raw);
    report.tailnet = host.endsWith('.ts.net');

    // 2. The name resolves.
    let addresses: Resolved[] = [];
    if (isIP(host)) {
      addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
      report.ok('dns', 'An address: nothing to look up.');
    } else {
      try {
        addresses = await (this.deps.lookup ?? resolveName)(host, LOOKUP_TIMEOUT_MS);
      } catch (err) {
        if ((err as { code?: string }).code === 'ETIMEOUT') {
          report.fail('dns', `Looking up ${host} took more than ${LOOKUP_TIMEOUT_MS / 1000} s.`, report.tailnet ? FIX.dnsTailnet : FIX.dnsSlow(host));
          return report.tailnet ? report.unconfirmed() : report.unreachable();
        }
      }
      if (!addresses.length) {
        report.fail('dns', `${host} doesn’t resolve from this server.`, report.tailnet ? FIX.dnsTailnet : FIX.dns(host));
        return report.tailnet ? report.unconfirmed() : report.unreachable();
      }
      const found = `${host} is ${list(addresses.slice(0, 3).map((a) => a.address))}`;
      // Only home addresses (the router or a local DNS answering the name): whatever passes now proves nothing outside.
      report.atHome = addresses.every((a) => isLocalAddress(a.address));
      if (report.atHome) report.set('dns', 'warn', `${found} here, a home address.`, FIX.dnsHome(raw));
      else report.ok('dns', `${found}.`);
    }

    // 3–5. Connect, accept the certificate, and get the answer only this server knows: at the name's first IPv4
    // address, then its first IPv6 one while they don't connect.
    const tries = [addresses.find((a) => a.family === 4), addresses.find((a) => a.family === 6)].filter((a): a is Resolved => !!a);
    const { token, answer } = this.issue();
    const target = new URL(`${raw}${REACHABLE_PATH}/${token}`);
    const refused: { at: Resolved; err: ProbeError }[] = [];
    try {
      for (const at of tries) {
        let res: ProbeAnswer;
        try {
          res = await (this.deps.fetch ?? fetchAt)(target, at, FETCH_TIMEOUT_MS);
        } catch (e) {
          const err = e instanceof ProbeError ? e : probeErrorOf(e);
          if (err.phase === 'connect') {
            refused.push({ at, err });
            continue;
          }
          return report.ok('connect', `Connected to ${shown(at)} on port ${port}.`).afterConnecting(err, raw, host, !isLocalAddress(at.address));
        }
        report.ok('connect', `Connected to ${shown(at)} on port ${port}.`).ok('certificate', certificateDetail(res.certificate));
        return report.answered(res, answer, raw);
      }
    } finally {
      // Outstanding only while its check runs.
      this.tokens.delete(token);
    }

    // Nothing connected at any address tried.
    report.fail('connect', refused.map(({ at, err }) => connectProblem(at, port, err)).join(' '), connectFix(raw, report.tailnet, refused));
    return report.tailnet || refused.some(({ at }) => !isLocalAddress(at.address)) ? report.unconfirmed() : report.unreachable();
  }
}

/** One check's steps as they're decided, and its verdict: steps not reached stay skipped. */
class Report {
  private readonly steps = new Map<ReachabilityStepKind, ReachabilityStep>(ORDER.map((id) => [id, { id, label: LABELS[id], status: 'skipped' }]));
  /** A ts.net address (Tailscale), reachable from the tailnet only. */
  tailnet = false;
  /** The name led to home addresses only. */
  atHome = false;

  constructor(
    private readonly publicUrl: string | undefined,
    private readonly now: () => number,
  ) {}

  set(id: ReachabilityStepKind, status: ReachabilityStatus, detail: string, fix?: string): this {
    this.steps.set(id, { id, label: LABELS[id], status, detail, ...(fix ? { fix } : {}) });
    return this;
  }

  ok(id: ReachabilityStepKind, detail: string): this {
    return this.set(id, 'ok', detail);
  }

  fail(id: ReachabilityStepKind, detail: string, fix: string): this {
    return this.set(id, 'fail', detail, fix);
  }

  unreachable(): ReachabilityCheck {
    return this.done('unreachable', 'Phones away from home can’t reach this server yet.');
  }

  unconfirmed(): ReachabilityCheck {
    const phone = this.tailnet ? 'with Tailscale on' : 'on mobile data';
    return this.done('unconfirmed', `This server couldn’t confirm it from inside your home: open ${this.publicUrl} on a phone ${phone} to be sure.`);
  }

  reachable(): ReachabilityCheck {
    // Reached at a home address: fine at home, unproven outside.
    return this.atHome ? this.unconfirmed() : this.done('reachable', `Phones away from home can reach this server at ${this.publicUrl}.`);
  }

  /** Connected, then failed: in the TLS handshake (the certificate) or waiting for the answer. */
  afterConnecting(err: ProbeError, raw: string, host: string, publicAddress: boolean): ReachabilityCheck {
    const outside = this.tailnet || publicAddress;
    if (err.phase === 'tls') {
      this.fail('certificate', certificateProblem(err, host), certificateFix(raw, this.tailnet, outside));
      // Caddy without a certificate for the name is the owner's own Caddy; anything else outside may be the router.
      return outside && err.code !== 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' ? this.unconfirmed() : this.unreachable();
    }
    this.ok('certificate', 'Accepted.');
    const problem = err.code === 'ETIMEDOUT' ? `${raw} didn’t answer within ${FETCH_TIMEOUT_MS / 1000} s.` : `${raw} closed the connection without answering.`;
    return this.fail('playarr', problem, FIX.noAnswer(this.tailnet)).unreachable();
  }

  /** Step 5: whether what answered is this server. */
  answered(res: ProbeAnswer, answer: string, raw: string): ReachabilityCheck {
    if (res.status === 200 && answerOf(res.body) === answer) return this.ok('playarr', `This Playarr answered at ${raw}.`).reachable();
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return this.fail('playarr', `The proxy answered (HTTP ${res.status}) but couldn’t reach Playarr.`, FIX.badGateway(this.tailnet)).unreachable();
    }
    if (res.status === 429) return this.fail('playarr', `${raw} answered 429 Too many requests.`, 'Wait a minute and check again.').unconfirmed();
    if (res.status >= 300 && res.status < 400) {
      const to = res.location ? ` to ${res.location}` : '';
      return this.fail('playarr', `${raw} answered with a redirect${to}, not as this server.`, FIX.otherServer).unreachable();
    }
    return this.fail('playarr', `Something answered at ${raw} (HTTP ${res.status}), but not this server.`, FIX.otherServer).unreachable();
  }

  private done(verdict: ReachabilityVerdict, summary: string): ReachabilityCheck {
    return {
      verdict,
      summary,
      ...(this.publicUrl ? { publicUrl: this.publicUrl } : {}),
      steps: ORDER.map((id) => this.steps.get(id)!),
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

/** The answer in the token route's body, if it's one. */
function answerOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { answer?: unknown } | null;
    return typeof parsed?.answer === 'string' ? parsed.answer : undefined;
  } catch {
    return undefined;
  }
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ETIMEDOUT']);
const isTlsCode = (code: string) => /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_)|^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|EPROTO)$/.test(code);

/** Something thrown that isn't a ProbeError (an error with only a code): how far it got, by its code. */
function probeErrorOf(e: unknown): ProbeError {
  const { message, code } = e as { message?: string; code?: string };
  const phase = code && CONNECT_CODES.has(code) ? 'connect' : code && isTlsCode(code) ? 'tls' : 'http';
  return new ProbeError(message ?? String(e), phase, code);
}

/** "203.0.113.7", "[2001:db8::7]". */
const shown = (at: Resolved) => (at.family === 6 ? `[${at.address}]` : at.address);

/** "a", "a and b", "a, b and c". */
const list = (items: string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function connectProblem(at: Resolved, port: number, err: ProbeError): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return `Nothing answers on port ${port} at ${shown(at)} (connection refused).`;
    case 'ETIMEDOUT':
      return `No answer from ${shown(at)} on port ${port} within ${FETCH_TIMEOUT_MS / 1000} s.`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${shown(at)} can’t be reached from this server (no route).`;
    default:
      return `Couldn’t connect to ${shown(at)} on port ${port}: ${err.message}.`;
  }
}

function connectFix(raw: string, tailnet: boolean, refused: { at: Resolved }[]): string {
  if (tailnet) {
    return `From inside Docker this server may not reach its own tailnet address, so open ${raw} on a phone with Tailscale on to be sure. If it doesn’t open there either, check that tailscale serve status on the server shows ${raw} proxying to http://127.0.0.1:4000.`;
  }
  if (refused.every(({ at }) => isLocalAddress(at.address))) {
    return 'The name leads to a home address and nothing answers there: check that Caddy is running on this machine (docker compose ps lists playarr-caddy; it needs COMPOSE_PROFILES=https in .env) and that the address is this machine’s.';
  }
  return (
    `Many home routers don’t let a machine reach the home’s own public address from inside (no hairpin NAT), so this can fail even when phones outside get through: open ${raw} on a phone on mobile data, Wi-Fi off, to be sure. ` +
    'If it doesn’t open there either, check that the router forwards ports 80 and 443 (TCP) to this machine and that Caddy is running (docker compose ps). ' +
    'If your internet provider shares one public address among many homes (CGNAT), forwarding can’t work: use Tailscale instead.'
  );
}

function certificateProblem(err: ProbeError, host: string): string {
  switch (err.code) {
    case 'CERT_HAS_EXPIRED':
      return 'The certificate has expired.';
    case 'CERT_NOT_YET_VALID':
      return 'The certificate isn’t valid yet: is this server’s clock right?';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The certificate is for another name, not ${host}.`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'The certificate is self-signed, so phones won’t trust it.';
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'The certificate isn’t from an authority phones trust.';
    case 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR':
      return `What answers on that port has no certificate for ${host} yet.`;
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'ERR_SSL_PACKET_LENGTH_TOO_LONG':
    case 'EPROTO':
      return 'Something answers on that port, but not with HTTPS.';
    case 'ECONNRESET':
      return 'The connection was closed before HTTPS was set up.';
    case 'ETIMEDOUT':
      return `HTTPS wasn’t set up within ${FETCH_TIMEOUT_MS / 1000} s.`;
    default:
      return `HTTPS couldn’t be set up: ${err.message}.`;
  }
}

function certificateFix(raw: string, tailnet: boolean, outside: boolean): string {
  if (tailnet) return 'tailscale serve gets its certificate itself once HTTPS certificates are on for your tailnet (the DNS page of Tailscale’s admin console).';
  const caddy =
    'Caddy gets a certificate from Let’s Encrypt by itself within a minute of starting, once ports 80 and 443 reach it from the internet and the name leads to your home; docker compose logs playarr-caddy says what went wrong.';
  return outside ? `${caddy} From inside the home some routers answer their public address themselves: if that’s what answered here, open ${raw} on a phone on mobile data to be sure.` : caddy;
}

/** "From Let’s Encrypt, valid until February 5, 2027." */
function certificateDetail(certificate: ProbeAnswer['certificate']): string {
  const until = certificate?.validTo ? new Date(certificate.validTo) : undefined;
  const date =
    until && !Number.isNaN(until.getTime()) ? until.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : undefined;
  if (certificate?.issuer && date) return `From ${certificate.issuer}, valid until ${date}.`;
  if (certificate?.issuer) return `From ${certificate.issuer}.`;
  return date ? `Valid until ${date}.` : 'Accepted.';
}

/** What to do, step by step. */
const FIX = {
  noAddress:
    'With Caddy (COMPOSE_PROFILES=https in .env), set PLAYARR_DOMAIN to your domain; otherwise set PUBLIC_URL to the https:// address phones should use. Then restart Playarr: docker compose up -d in its folder. The guide shows both ways, and Tailscale’s.',
  notHttps:
    'Away from home, Playarr needs HTTPS: put Caddy or Tailscale in front of it (see the guide), then set PLAYARR_DOMAIN (with Caddy) or PUBLIC_URL to the https:// address.',
  homeAddress: 'Use a name the internet can reach: your own domain with Caddy, or this server’s ts.net name with Tailscale.',
  dns: (host: string) =>
    `At your domain’s DNS provider, add an A record for ${host} with your home’s public address (and an AAAA record if your home has IPv6). A new record can take a few minutes to show up.`,
  dnsSlow: (host: string) => `Check again in a moment. If it keeps happening, check this server’s DNS settings, and that ${host} has an A record at your DNS provider.`,
  dnsTailnet:
    'A ts.net name resolves only on your tailnet, and this server may not use Tailscale’s DNS from inside Docker: open the address on a phone with Tailscale on to be sure.',
  dnsHome: (raw: string) =>
    `Fine at home if your router or DNS answers the name with the home address on purpose. Outside, the name must lead to your home’s public address: open ${raw} on a phone on mobile data to be sure.`,
  noAnswer: (tailnet: boolean) =>
    tailnet
      ? 'Something took the connection but didn’t answer: check tailscale serve status on the server.'
      : 'Something took the connection but didn’t answer: docker compose logs playarr-caddy may say why.',
  badGateway: (tailnet: boolean) =>
    tailnet
      ? 'tailscale serve must proxy to http://127.0.0.1:4000, and Playarr must be running (docker compose ps).'
      : 'Check that Playarr and Caddy both run in Playarr’s folder (docker compose ps); docker compose logs playarr-caddy says why it can’t reach playarr:4000.',
  otherServer:
    'The name or the router’s forwarding leads somewhere else: another server, the router’s own page, or another Playarr. Check that the DNS record has your home’s address, the router forwards 443 to this machine, and the proxy hands requests to this Playarr.',
};
