import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Paths that are the server's own, never pages of the web app. */
const SERVER_PATH = /^\/(api|stream|art|transitions)\//;
/** A file's path (`/assets/Queue-3f2a.js`, `/favicon.png`), as opposed to one of the app's pages (`/albums/12`). */
const FILE_PATH = /\/[^/]+\.[a-z0-9]+$/i;

/**
 * The built web app, from the same origin: its files as they are, and index.html for any page of the app, so links
 * into it open. A file that isn't there is a 404, not index.html: a tab still on the previous build asking for a
 * chunk the new one replaced must fail to load it (and reload into the new build), not be handed a page as code.
 */
export async function serveWebApp(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, { root, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    return SERVER_PATH.test(path) || FILE_PATH.test(path) || req.method !== 'GET'
      ? reply.code(404).send({ error: 'Not found' })
      : reply.sendFile('index.html');
  });
}
