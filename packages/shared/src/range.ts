/** Inclusive byte range, like fs.createReadStream's start/end. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range "bytes=" header (shared by the server and the service worker, so kept songs
 * answer exactly like streamed ones). Returns null if unsatisfiable, undefined if absent/ignored.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | null | undefined {
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
