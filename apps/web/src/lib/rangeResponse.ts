import { parseRange } from '@playarr/shared';

/**
 * Answer a request from a stored response the way the server would: the whole file, or the one
 * byte range asked for (used by the service worker to play kept songs, seeking included).
 */
export async function rangeResponse(request: Request, stored: Response): Promise<Response> {
  const blob = await stored.blob();
  const range = parseRange(request.headers.get('range'), blob.size);
  if (range === undefined) return new Response(blob, { headers: stored.headers });
  if (range === null) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  const headers = new Headers(stored.headers);
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${blob.size}`);
  headers.set('Content-Length', String(range.end - range.start + 1));
  return new Response(blob.slice(range.start, range.end + 1), { status: 206, headers });
}
