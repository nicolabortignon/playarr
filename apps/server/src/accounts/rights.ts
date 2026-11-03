import type { FastifyReply, FastifyRequest } from 'fastify';
import { isLocalRequest } from '../net.ts';
import type { Accounts } from './accounts.ts';

/** No accounts to go by: nobody has set up the server yet, or the routes run without accounts (tests). */
const byHomeNetwork = (req: FastifyRequest) => req.auth === undefined || req.auth?.setup === true;

/** Admins change settings, sources, analysis and accounts; before setup, anyone on the home network. */
export function isAdmin(req: FastifyRequest): boolean {
  if (byHomeNetwork(req)) return isLocalRequest(req);
  return req.auth?.account.role === 'admin';
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (isAdmin(req)) return;
  return reply.code(403).send({ error: byHomeNetwork(req) ? 'Settings can only be changed from your home network' : 'Only an admin can change this' });
}

/** Your own settings (ListenBrainz, your history): yours once signed in; before setup, from the home network. */
export async function requireOwn(req: FastifyRequest, reply: FastifyReply) {
  if (byHomeNetwork(req) ? isLocalRequest(req) : !!req.auth) return;
  return reply.code(403).send({ error: 'Settings can only be changed from your home network' });
}

/** Claiming the owner account: only while no account has a password, and only from the home network. */
export function requireLocalSetup(accounts: Pick<Accounts, 'setupMode'>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!accounts.setupMode()) return reply.code(409).send({ error: 'This server is already set up: sign in instead' });
    if (!isLocalRequest(req)) return reply.code(403).send({ error: 'Setting up Playarr works from your home network' });
  };
}

/** The account a request is for: its own, the owner's in setup mode, 1 without accounts. */
export const accountId = (req: FastifyRequest): number => req.auth?.account.id ?? 1;

/** Requests need the account's right (Settings → Accounts); everyone had it before accounts. */
export function canRequest(req: FastifyRequest): boolean {
  if (req.auth === undefined) return true;
  if (!req.auth) return false;
  return req.auth.setup || req.auth.account.canRequest;
}

export async function requireCanRequest(req: FastifyRequest, reply: FastifyReply) {
  if (!canRequest(req)) return reply.code(403).send({ error: 'Your account can’t request albums' });
}
