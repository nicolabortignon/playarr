import { parseRange } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import { FileAccessError, type FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import { mimeForPath } from '../library/format.ts';
import { MediaUnavailableError, type MediaSource } from '../media/index.ts';

export function streamRoutes(app: FastifyInstance, deps: { library: Library; files: FileResolver }) {
  const { library } = deps;

  app.route<{ Params: { fileId: string } }>({
    method: ['GET', 'HEAD'],
    url: '/stream/:fileId',
    handler: async (req, reply) => {
      const fileId = Number(req.params.fileId);
      // Only serve files Lidarr knows about: the client never supplies a path.
      const file = Number.isInteger(fileId) ? await library.file(fileId) : undefined;
      if (!file) return reply.code(404).send({ error: 'Unknown track file' });

      // Defense in depth: never read outside the source's folder or the configured roots.
      let media: MediaSource;
      let path: string;
      try {
        ({ media, path } = deps.files.resolve(file));
      } catch (err) {
        if (!(err instanceof FileAccessError)) throw err;
        req.log.warn({ path: file.path }, err.message);
        return reply.code(err.status).send({ error: err.message });
      }
      let size: number;
      let mtimeMs: number;
      try {
        ({ size, mtimeMs } = await media.stat(path));
      } catch (err) {
        if (err instanceof MediaUnavailableError) return reply.code(503).send({ error: err.message });
        req.log.warn({ err, path }, 'stat failed');
        return reply.code(502).send({ error: `Cannot read audio file: ${(err as Error).message}` });
      }

      const etag = `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
      reply
        .header('Accept-Ranges', 'bytes')
        .header('Content-Type', mimeForPath(path))
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=86400');

      if (req.headers['if-none-match'] === etag) return reply.code(304).send();

      const range = parseRange(req.headers.range, size);
      if (range === null) {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      if (range) {
        reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      }
      reply.header('Content-Length', range ? range.end - range.start + 1 : size);
      if (req.method === 'HEAD') return reply.send();

      const stream = await media.open(path, range);
      // Stop reading from disk/SSH as soon as the browser drops the connection (seek, skip).
      // (The response's close event: the request's fires once its body has been read.)
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    },
  });
}
