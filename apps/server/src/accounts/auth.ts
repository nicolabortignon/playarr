import type { Account } from '@playarr/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isFromApp } from '../net.ts';
import type { Accounts } from './accounts.ts';
import type { Sessions } from './sessions.ts';

export const SESSION_COOKIE = 'playarr_session';
/** How long the browser keeps the session cookie: its longest (the session itself lasts until signed out). */
const COOKIE_MAX_AGE = 400 * 86_400;

/** Who a request is for. */
export interface RequestAuth {
  /** No account has a password yet: everyone acts as the owner and the home network decides rights. */
  setup: boolean;
  account: Account;
  /** The session it came with; none in setup mode. */
  session: { id: number; via: 'bearer' | 'cookie' } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by authHook: who's asking, or null for an unsigned request to an open route. Undefined only
     * when the routes run without accounts (their tests), which the rights helpers treat as setup mode.
     */
    auth?: RequestAuth | null;
  }
}

/** Behind sign-in once any account has a password. */
const PROTECTED = /^\/(api|stream|art|transitions)\//;
/** Open to anyone: what an app needs to find this server and sign in. Switch checks the token it's sent. */
const OPEN = new Set(['GET /api/server', 'GET /api/health', 'POST /api/auth/sign-in', 'POST /api/auth/redeem', 'POST /api/auth/setup', 'POST /api/auth/switch']);

/** One cookie's value from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The token a request carries: `Authorization: Bearer` (the app) or the session cookie (the web). */
export function credentials(req: Pick<FastifyRequest, 'headers'>): { token: string; via: 'bearer' | 'cookie' } | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+\S/i.test(header)) return { token: header.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  return cookie ? { token: cookie, via: 'cookie' } : undefined;
}

/** True when the visitor came over HTTPS (directly or through a proxy that says so). */
const overHttps = (req: FastifyRequest) => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

/** The Set-Cookie value that makes `token` this browser's session, or ends it (null). */
export function sessionCookie(req: FastifyRequest, token: string | null): string {
  const parts = [`${SESSION_COOKIE}=${token ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? COOKIE_MAX_AGE : 0}`];
  if (overHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/** This server as the visitor reached it (for setup links). */
export function originOf(req: FastifyRequest): string {
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' && forwardedHost) || req.headers.host || 'localhost';
  return `${overHttps(req) ? 'https' : 'http'}://${host}`;
}

/** Decides who every request is for (req.auth), and turns away what it may not do. */
export function authHook(deps: { accounts: Pick<Accounts, 'get' | 'owner' | 'setupMode'>; sessions: Pick<Sessions, 'resolve'> }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    const given = credentials(req);
    // Changes must come from Playarr's own pages (see isFromApp). Other sites can't send a Bearer token.
    if (path.startsWith('/api/') && given?.via !== 'bearer' && !isFromApp(req)) {
      return reply.code(403).send({ error: 'Changes must come from Playarr itself' });
    }
    const session = given && deps.sessions.resolve(given.token);
    const account = session && deps.accounts.get(session.accountId);
    if (session && account) {
      req.auth = { setup: false, account, session: { id: session.id, via: given.via } };
      return;
    }
    if (deps.accounts.setupMode()) {
      req.auth = { setup: true, account: deps.accounts.owner(), session: null };
      return;
    }
    req.auth = null;
    const route = `${req.method === 'HEAD' ? 'GET' : req.method} ${path}`;
    if (PROTECTED.test(path) && !OPEN.has(route)) return reply.code(401).send({ error: 'Sign in to Playarr', setup: false });
  };
}
