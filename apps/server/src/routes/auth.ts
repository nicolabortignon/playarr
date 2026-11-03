import type { Account, SignInResponse } from '@playarr/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountError, checkPassword, type Accounts } from '../accounts/accounts.ts';
import { sessionCookie } from '../accounts/auth.ts';
import { RateLimiter } from '../accounts/rateLimit.ts';
import { requireLocalSetup } from '../accounts/rights.ts';
import type { Sessions } from '../accounts/sessions.ts';
import type { SetupCodes } from '../accounts/setupCodes.ts';

const device = {
  device: z.string().trim().max(80).default('Unknown device'),
  platform: z.string().trim().max(20).default('web'),
};
const setupInput = z.object({ username: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(40), password: z.string().max(200), ...device });
const signInInput = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200), ...device });
const redeemInput = z.object({ code: z.string().trim().min(1).max(32), password: z.string().max(200), ...device });
const switchInput = z.object({ token: z.string().min(1).max(200) });

const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';

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

/** Claiming the server, signing in and out, setup codes, and who's signed in. */
export function authRoutes(
  app: FastifyInstance,
  deps: { accounts: Accounts; sessions: Sessions; setupCodes: SetupCodes; limiter?: RateLimiter },
) {
  const { accounts, sessions, setupCodes } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
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
      accounts.update(owner.id, { username: input.username, name: input.name, role: 'admin' });
      await accounts.setPassword(owner.id, input.password);
      return signedIn(accounts.get(owner.id)!, input);
    }),
  );

  app.post('/api/auth/sign-in', (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(signInInput, req.body);
      const keys = [`ip:${req.ip}`, `user:${input.username.toLowerCase()}`];
      if (!limiter.allows(keys)) return reply.code(429).send({ error: TOO_MANY });
      const account = await accounts.verify(input.username, input.password);
      if (!account) {
        limiter.fail(keys);
        return reply.code(401).send({ error: 'Wrong username or password', setup: accounts.setupMode() });
      }
      limiter.clear(keys[1]!);
      return signedIn(account, input);
    }),
  );

  // A new or reset account chooses its password with the code an admin gave them.
  app.post('/api/auth/redeem', (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(redeemInput, req.body);
      const keys = [`ip:${req.ip}`];
      if (!limiter.allows(keys)) return reply.code(429).send({ error: TOO_MANY });
      const id = setupCodes.accountFor(input.code);
      if (id === undefined) {
        limiter.fail(keys);
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
    if (auth.session.via === 'cookie') reply.header('set-cookie', sessionCookie(req, null));
    return reply.code(204).send();
  });

  app.get('/api/auth/me', (req, reply) =>
    req.auth?.session ? req.auth.account : reply.code(401).send({ error: 'Nobody is signed in', setup: accounts.setupMode() }),
  );

  // The web keeps a token per account signed in on the device; switching makes one the cookie.
  app.post('/api/auth/switch', (req, reply) => {
    const parsed = switchInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A token is required' });
    const session = sessions.resolve(parsed.data.token);
    const account = session && accounts.get(session.accountId);
    if (!account) return reply.code(401).send({ error: 'That sign-in has ended: sign in again', setup: accounts.setupMode() });
    reply.header('set-cookie', sessionCookie(req, parsed.data.token));
    return account;
  });
}
