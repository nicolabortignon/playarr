import type { Account, AuthProof, DeviceCodeInfo, DevicePoll, SignInResponse } from '@playarr/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountError, checkPassword, type Accounts } from '../accounts/accounts.ts';
import { KEPT_COOKIE, keptCookie, originOf, readCookie, sessionCookie } from '../accounts/auth.ts';
import { DeviceCodes } from '../accounts/deviceCodes.ts';
import { RateLimiter } from '../accounts/rateLimit.ts';
import { requireLocalSetup } from '../accounts/rights.ts';
import type { Sessions } from '../accounts/sessions.ts';
import type { SetupCodes } from '../accounts/setupCodes.ts';
import { APP_HEADER, isLocalRequest } from '../net.ts';

const device = {
  device: z.string().trim().max(80).default('Unknown device'),
  platform: z.string().trim().max(20).default('web'),
};
const setupInput = z.object({ username: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(40), password: z.string().max(200), ...device });
const signInInput = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200), ...device });
const redeemInput = z.object({ code: z.string().trim().min(1).max(32), password: z.string().max(200), ...device });
const tokenInput = z.object({ token: z.string().min(1).max(200) });
/** A token (just signed in), or an account whose token this browser keeps as a cookie. */
const switchInput = z.union([tokenInput, z.object({ accountId: z.number().int().positive() })]);
// An HMAC-SHA256 in base64url, and a nonce of at least 128 random bits.
const proofInput = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/) });
const deviceInput = z.object({ device: z.string().trim().min(1).max(80).default('TV'), platform: z.string().trim().min(1).max(20).default('tv') });
const pollInput = z.object({ pollToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const codeInput = z.object({ code: z.string().trim().min(1).max(32) });

const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';
/** Home-address proofs per client address in 15 minutes: an app asks once per network it joins. */
const PROOFS = 30;
/** Codes a device may start per client address in 15 minutes: each lasts 10 minutes. */
const DEVICE_STARTS = 20;
/** Polls per client address in 15 minutes: one every 5 s is 180. */
const DEVICE_POLLS = 300;

/** A request body as `schema` wants it, or a 400 naming what's wrong. */
export function parseInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new AccountError(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

/** Runs a handler, answering an AccountError with its status and message. */
export async function handleAccountErrors(reply: FastifyReply, fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AccountError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

/** Claiming the server, signing in and out, setup codes, who's signed in, and the home-address proof. */
export function authRoutes(
  app: FastifyInstance,
  deps: {
    accounts: Accounts;
    sessions: Sessions;
    setupCodes: SetupCodes;
    deviceCodes?: DeviceCodes;
    /** PUBLIC_URL: where a device's code is approved (`verifyUrl`), whoever reached the server how. */
    publicUrl?: string;
    limiter?: RateLimiter;
    proofLimiter?: RateLimiter;
    deviceLimiter?: RateLimiter;
    pollLimiter?: RateLimiter;
  },
) {
  const { accounts, sessions, setupCodes } = deps;
  const deviceCodes = deps.deviceCodes ?? new DeviceCodes();
  // Failed sign-ins and codes count per client address: req.ip, the visitor's behind a proxy trusted with TRUST_PROXY.
  const limiter = deps.limiter ?? new RateLimiter();
  const proofLimiter = deps.proofLimiter ?? new RateLimiter(PROOFS);
  const deviceLimiter = deps.deviceLimiter ?? new RateLimiter(DEVICE_STARTS);
  // Every address outside together may poll as much as 10 TVs signing in at once.
  const pollLimiter = deps.pollLimiter ?? new RateLimiter(DEVICE_POLLS, 15 * 60_000, Date.now, DEVICE_POLLS * 10);
  const signedIn = (account: Account, input: { device: string; platform: string }): SignInResponse => ({
    token: sessions.create(account.id, input.device, input.platform).token,
    account,
  });

  // The owner sets their username and password: from the home network, while nobody has one.
  app.post('/api/auth/setup', { onRequest: requireLocalSetup(accounts) }, (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(setupInput, req.body);
      checkPassword(input.password);
      const owner = accounts.owner();
      // Profiles became accounts with usernames of their own: say whose, so the owner knows what to do.
      const holder = accounts.byUsername(input.username);
      if (holder && holder.id !== owner.id) {
        return reply.code(409).send({ error: `That username belongs to ${holder.name}. Pick another; you can rename them later.` });
      }
      accounts.update(owner.id, { username: input.username, name: input.name, role: 'admin' });
      await accounts.setPassword(owner.id, input.password);
      return signedIn(accounts.get(owner.id)!, input);
    }),
  );

  app.post('/api/auth/sign-in', (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(signInInput, req.body);
      if (!limiter.allows(req.ip)) return reply.code(429).send({ error: TOO_MANY });
      const account = await accounts.verify(input.username, input.password);
      if (!account) {
        limiter.fail(req.ip);
        return reply.code(401).send({ error: 'Wrong username or password', setup: accounts.setupMode() });
      }
      return signedIn(account, input);
    }),
  );

  // A new or reset account chooses its password with the code an admin gave them.
  app.post('/api/auth/redeem', (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(redeemInput, req.body);
      if (!limiter.allows(req.ip)) return reply.code(429).send({ error: TOO_MANY });
      const id = setupCodes.accountFor(input.code);
      if (id === undefined) {
        limiter.fail(req.ip);
        return reply.code(400).send({ error: 'That code is wrong, used or expired. Ask for a new one.' });
      }
      await accounts.setPassword(id, input.password); // a password too short leaves the code unused
      setupCodes.use(input.code);
      return signedIn(accounts.get(id)!, input);
    }),
  );

  app.post('/api/auth/sign-out', (req, reply) => {
    const auth = req.auth;
    if (!auth?.session) return reply.code(401).send({ error: 'Nobody is signed in', setup: accounts.setupMode() });
    sessions.remove(auth.account.id, auth.session.id);
    if (auth.session.via === 'cookie') reply.header('set-cookie', [sessionCookie(req, null), keptCookie(req, auth.account.id, null)]);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', (req, reply) =>
    req.auth?.session ? req.auth.account : reply.code(401).send({ error: 'Nobody is signed in', setup: accounts.setupMode() }),
  );

  // The iOS app asks before its token goes to this server's home address, on a network it can't vouch for: the
  // server there proves it holds the session, from a question that gives nothing away (Sessions.proof). Open, and
  // asked without the token, but only with Playarr's own header, which a web page can't send another site without
  // asking first: a page open on a phone at home can't spend that phone's questions. Every question counts toward
  // the limit, answered or not: counting only the misses would let the limit say which ids matched.
  app.get('/api/auth/proof', (req, reply) => {
    if (req.headers[APP_HEADER] !== '1') return reply.code(403).send({ error: 'Only the Playarr app asks this' });
    const parsed = proofInput.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'An id and a nonce are required' });
    if (!proofLimiter.take(req.ip)) return reply.code(429).send({ error: TOO_MANY });
    const answer: AuthProof = { proof: sessions.proof(parsed.data.id, parsed.data.nonce, isLocalRequest(req)) };
    return answer;
  });

  // Signing in a TV from the sofa (plan 9 §3): the TV starts a code, someone signed in on a phone or the web approves
  // it for their account (the /link page), and the TV collects a session of its own with a token only it has. Starting
  // and polling are open, and counted per address; approving needs a session, so a code is no way in by itself. Wrong
  // codes count as failed tries, as setup codes do.
  app.post('/api/auth/device', (req, reply) => {
    const parsed = deviceInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'A device name and platform, at most 80 and 20 characters' });
    if (accounts.setupMode()) return reply.code(409).send({ error: 'Set up Playarr on a phone or computer first' });
    if (!deviceLimiter.take(req.ip)) return reply.code(429).send({ error: TOO_MANY });
    return deviceCodes.start(parsed.data.device, parsed.data.platform, originOf(req, deps.publicUrl));
  });

  app.post('/api/auth/device/poll', (req, reply) => {
    const parsed = pollInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A poll token is required' });
    if (!pollLimiter.take(req.ip)) return reply.code(429).send({ error: TOO_MANY });
    const answer = deviceCodes.poll(parsed.data.pollToken);
    if (answer.status !== 'approved') return answer satisfies DevicePoll;
    const account = accounts.get(answer.accountId);
    // The account went while the TV was waiting.
    if (!account) return { status: 'expired' } satisfies DevicePoll;
    return { status: 'approved', ...signedIn(account, answer) } satisfies DevicePoll;
  });

  const needsSession = (reply: FastifyReply) => reply.code(401).send({ error: 'Sign in to approve a device', setup: accounts.setupMode() });

  app.post('/api/auth/device/lookup', (req, reply) => {
    if (!req.auth?.session) return needsSession(reply);
    const parsed = codeInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A code is required' });
    if (!limiter.allows(req.ip)) return reply.code(429).send({ error: TOO_MANY });
    const info = deviceCodes.lookup(parsed.data.code);
    if (!info) {
      limiter.fail(req.ip);
      return reply.code(404).send({ error: 'That code is wrong, used or expired. Start again on the TV.' });
    }
    return info satisfies DeviceCodeInfo;
  });

  app.post('/api/auth/device/approve', (req, reply) => {
    if (!req.auth?.session) return needsSession(reply);
    const parsed = codeInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A code is required' });
    if (!limiter.allows(req.ip)) return reply.code(429).send({ error: TOO_MANY });
    const info = deviceCodes.approve(parsed.data.code, req.auth.account.id);
    if (!info) {
      limiter.fail(req.ip);
      return reply.code(404).send({ error: 'That code is wrong, used or expired. Start again on the TV.' });
    }
    return info satisfies DeviceCodeInfo;
  });

  // The web keeps each account signed in on the browser (`keptCookie`); switching makes one's token the session cookie:
  // a token just signed in with, or the one kept for an account. Either is kept from then on.
  app.post('/api/auth/switch', (req, reply) => {
    const parsed = switchInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A token or an account is required' });
    const asked = 'accountId' in parsed.data ? parsed.data.accountId : undefined;
    const token = asked === undefined ? (parsed.data as { token: string }).token : readCookie(req.headers.cookie, `${KEPT_COOKIE}${asked}`);
    const session = token ? sessions.resolve(token) : undefined;
    const account = session && (asked === undefined || session.accountId === asked) ? accounts.get(session.accountId) : undefined;
    if (!account || !token) {
      // A kept sign-in that has ended goes.
      if (asked !== undefined) reply.header('set-cookie', keptCookie(req, asked, null));
      return reply.code(401).send({ error: 'That sign-in has ended: sign in again', setup: accounts.setupMode() });
    }
    reply.header('set-cookie', [sessionCookie(req, token), keptCookie(req, account.id, token)]);
    return account;
  });

  // Tokens an older web app kept in localStorage, handed over once to be kept as cookies no script can read.
  app.post('/api/auth/keep', (req, reply) => {
    const parsed = tokenInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A token is required' });
    const session = sessions.resolve(parsed.data.token);
    const account = session && accounts.get(session.accountId);
    if (!account) return reply.code(401).send({ error: 'That sign-in has ended: sign in again', setup: accounts.setupMode() });
    reply.header('set-cookie', keptCookie(req, account.id, parsed.data.token));
    return account;
  });
}
