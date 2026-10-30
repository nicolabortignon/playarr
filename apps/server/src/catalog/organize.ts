import type { OrganizeMove, OrganizeSkip } from '@playarr/shared';

/** A folder file and where the catalog says it belongs. */
export interface OrganizeFile {
  rel: string;
  artist: string;
  /** Undefined for songs without a known album. */
  album?: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  multiDisc: boolean;
  confident: boolean;
}

const MAX_SEGMENT = 120;

/** A file or folder name that's safe on every common filesystem. */
export function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_SEGMENT)
    .replace(/[\s.]+$/g, '');
  return cleaned || 'Unknown';
}

/** Where a file belongs: Artist/Album/NN Title.ext (D-NN on multi-disc albums), or Artist/Title.ext. */
export function targetFor(f: OrganizeFile): string {
  const ext = f.rel.split('.').pop()!.toLowerCase();
  const title = safeSegment(f.title);
  const artist = safeSegment(f.artist);
  if (!f.album) return `${artist}/${title}.${ext}`;
  const number = f.trackNumber > 0 ? String(f.trackNumber).padStart(2, '0') : '';
  const prefix = number ? `${f.multiDisc ? `${f.discNumber}-` : ''}${number} ` : '';
  return `${artist}/${safeSegment(f.album)}/${prefix}${title}.${ext}`;
}

/** The moves that would tidy these files, and the ones that can't happen. `exists`: is that relative path taken? */
export function planMoves(files: OrganizeFile[], exists: (rel: string) => boolean): { moves: OrganizeMove[]; skipped: OrganizeSkip[] } {
  const moves: OrganizeMove[] = [];
  const skipped: OrganizeSkip[] = [];
  const targets = new Map(files.map((f) => [f, targetFor(f)]));
  // Files already in place keep their paths: nothing may move onto them, not even by a case-only rename.
  const inPlace = new Set(files.filter((f) => targets.get(f) === f.rel).map((f) => f.rel.toLowerCase()));
  const claimed = new Set<string>();
  // Confident files claim their targets first; then by path, for a stable order.
  const ordered = [...files].sort((a, b) => Number(b.confident) - Number(a.confident) || a.rel.localeCompare(b.rel));
  for (const f of ordered) {
    const to = targets.get(f)!;
    if (to === f.rel) continue;
    const key = to.toLowerCase();
    const sameFile = key === f.rel.toLowerCase(); // a case-only rename
    if (claimed.has(key)) {
      skipped.push({ from: f.rel, to, reason: 'Another file is going there' });
      continue;
    }
    if (inPlace.has(key) || (!sameFile && exists(to))) {
      skipped.push({ from: f.rel, to, reason: 'A file is already there' });
      continue;
    }
    claimed.add(key);
    moves.push({ from: f.rel, to, artist: f.artist, album: f.album, confident: f.confident });
  }
  return { moves, skipped };
}
