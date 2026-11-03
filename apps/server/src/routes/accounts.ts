import type { CreatedAccount } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccountError, type Accounts } from '../accounts/accounts.ts';
import { originOf } from '../accounts/auth.ts';
import { isAdmin, requireAdmin } from '../accounts/rights.ts';
import type { Sessions } from '../accounts/sessions.ts';
import type { SetupCodes } from '../accounts/setupCodes.ts';
import { handleAccountErrors, parseInput } from './auth.ts';

const accountInput = z.object({
  username: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  role: z.enum(['admin', 'member']),
  canRequest: z.boolean(),
  sources: z.array(z.number().int().positive()).max(100).nullable(),
});
const accountPatch = accountInput.partial();

type Id = { Params: { id: string } };

/** Settings → Accounts: admins manage everyone; each account sees and signs out its own devices. */
export function accountRoutes(app: FastifyInstance, deps: { accounts: Accounts; sessions: Sessions; setupCodes: SetupCodes }) {
  const { accounts, sessions, setupCodes } = deps;
  // A code redeemed before the owner has a password would end setup mode and lock the owner out.
  const ownerFirst = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (accounts.setupMode()) return reply.code(409).send({ error: 'Set up the owner’s account first (Settings → Accounts)' });
  };
  const self = (req: FastifyRequest, id: number) => !!req.auth?.session && req.auth.account.id === id;
  const known = (id: number) => {
    if (!accounts.get(id)) throw new AccountError('No such account', 404);
    return id;
  };

  app.get('/api/accounts', { onRequest: requireAdmin }, () => accounts.list());

  app.post('/api/accounts', { onRequest: [requireAdmin, ownerFirst] }, (req, reply) =>
    handleAccountErrors(reply, () => {
      const account = accounts.create(parseInput(accountInput, req.body));
      return reply.code(201).send({ account, setup: setupCodes.issue(account.id, originOf(req)) } satisfies CreatedAccount);
    }),
  );

  app.patch<Id>('/api/accounts/:id', (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = Number(req.params.id);
      const patch = parseInput(accountPatch, req.body);
      const onlyName = Object.keys(patch).every((key) => key === 'name');
      if (!isAdmin(req) && !(self(req, id) && onlyName)) return reply.code(403).send({ error: 'Only an admin can change this' });
      return accounts.update(id, patch);
    }),
  );

  app.delete<Id>('/api/accounts/:id', { onRequest: requireAdmin }, (req, reply) =>
    handleAccountErrors(reply, () => {
      accounts.remove(Number(req.params.id));
      return accounts.list();
    }),
  );

  // A forgotten password: signed out everywhere, and a new code to choose another.
  app.post<Id>('/api/accounts/:id/reset', { onRequest: [requireAdmin, ownerFirst] }, (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = known(Number(req.params.id));
      accounts.clearPassword(id);
      sessions.removeAll(id);
      return setupCodes.issue(id, originOf(req));
    }),
  );

  app.get<Id>('/api/accounts/:id/sessions', (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = Number(req.params.id);
      if (!isAdmin(req) && !self(req, id)) return reply.code(403).send({ error: 'Only an admin can see this' });
      return sessions.list(known(id), req.auth?.session?.id);
    }),
  );

  app.delete<{ Params: { id: string; sessionId: string } }>('/api/accounts/:id/sessions/:sessionId', (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = Number(req.params.id);
      if (!isAdmin(req) && !self(req, id)) return reply.code(403).send({ error: 'Only an admin can change this' });
      if (!sessions.remove(known(id), Number(req.params.sessionId))) throw new AccountError('No such session', 404);
      return sessions.list(id, req.auth?.session?.id);
    }),
  );
}
