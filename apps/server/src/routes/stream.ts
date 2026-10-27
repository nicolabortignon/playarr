import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import type { Library } from '../library/library.ts';
import { mimeForPath } from '../library/format.ts';
import { mapPath, MediaUnavailableError, type MediaSource } from '../media/index.ts';
import type { ByteRange } from '../media/source.ts';

/** Parse a single-range "bytes=" header. Returns null if unsatisfiable, undefined if absent/ignored. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | undefined {
  if (!header?.startsWith('bytes=')) return undefined;
  const spec = header.slice(6).split(',')[0]!.trim(); // multi-range: serve the first one
  const [rawStart = '', rawEnd = ''] = spec.split('-');
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

export function streamRoutes(app: FastifyInstance, deps: { config: Config; library: Library; media: MediaSource }) {
  const { config, library, media } = deps;

  app.route<{ Params: { fileId: string } }>({
    method: ['GET', 'HEAD'],
    url: '/stream/:fileId',
    handler: async (req, reply) => {
      const fileId = Number(req.params.fileId);
      // Only serve files Lidarr knows about: the client never supplies a path.
      const file = Number.isInteger(fileId) ? await library.file(fileId) : undefined;
      if (!file) return reply.code(404).send({ error: 'Unknown track file' });

      const path = mapPath(file.path, config.pathMap);
      // Defense in depth: when roots are configured, never read outside them.
      const roots = config.pathMap.map(([, to]) => (to.endsWith('/') ? to : `${to}/`));
      if (roots.length && !roots.some((root) => path.startsWith(root))) {
        req.log.warn({ path }, 'refusing to stream outside configured roots');
        return reply.code(403).send({ error: 'File is outside the configured music folders' });
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
