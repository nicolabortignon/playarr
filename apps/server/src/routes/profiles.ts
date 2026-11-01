import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProfileError, type Profiles } from '../profiles/profiles.ts';
import { requireLocal } from './settings.ts';

const nameInput = z.object({ name: z.string().max(100) });

/** Who listens: anyone can see the profiles (to pick one); they're changed from the home network. */
export function profileRoutes(app: FastifyInstance, deps: { profiles: Profiles; onRemoved?: (id: number) => void }) {
  const { profiles } = deps;
  const editable = { onRequest: requireLocal };
  const run = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => unknown) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProfileError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  };

  app.get('/api/profiles', () => profiles.list());

  app.post('/api/profiles', editable, (req, reply) =>
    run(reply, () => {
      const parsed = nameInput.safeParse(req.body);
      if (!parsed.success) throw new ProfileError('A profile needs a name');
      return reply.code(201).send(profiles.create(parsed.data.name));
    }),
  );

  app.patch<{ Params: { id: string } }>('/api/profiles/:id', editable, (req, reply) =>
    run(reply, () => {
      const parsed = nameInput.safeParse(req.body);
      if (!parsed.success) throw new ProfileError('A profile needs a name');
      return profiles.rename(Number(req.params.id), parsed.data.name);
    }),
  );

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', editable, (req, reply) =>
    run(reply, () => {
      profiles.remove(Number(req.params.id));
      deps.onRemoved?.(Number(req.params.id));
      return profiles.list();
    }),
  );
}
