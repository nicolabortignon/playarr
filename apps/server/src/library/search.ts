/** Lowercase, strip diacritics and punctuation so "L’Impératrice" matches "limperatrice". */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 0 = no match; higher is better. `query` must already be normalized. */
export function scoreMatch(query: string, text: string): number {
  const t = normalize(text);
  if (!t) return 0;
  if (t === query) return 100;
  if (t.startsWith(query)) return 80;
  if (t.includes(` ${query}`)) return 60;
  if (t.includes(query)) return 40;
  // Every query word appears somewhere (e.g. "punk daft").
  const words = query.split(' ');
  if (words.length > 1 && words.every((w) => t.includes(w))) return 20;
  return 0;
}

/**
 * 0 = not near; higher is closer. For a query that matches nothing as typed (`query` normalized): each of its words
 * within a letter or two of a word of `text` ("radiohed" finds Radiohead, "massive atack" Massive Attack), or the
 * whole query within a few letters of the whole text, run together ("daftpunk", "radio head").
 */
export function scoreNearMatch(query: string, text: string): number {
  const t = normalize(text);
  if (!t) return 0;
  const joined = query.replaceAll(' ', '');
  const whole = editDistance(joined, t.replaceAll(' ', ''), slack(joined));
  if (whole <= slack(joined)) return 10 - whole;
  const words = t.split(' ');
  let off = 0;
  for (const q of query.split(' ')) {
    const max = slack(q);
    let best = max + 1;
    for (const w of words) {
      best = Math.min(best, editDistance(q, w, max));
      if (best === 0) break;
    }
    if (best > max) return 0;
    off += best;
  }
  return 10 - off;
}

/** How many letters a word may be off and still be near: none for short words, where any change makes another word. */
function slack(word: string): number {
  return word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
}

/**
 * Letters to insert, delete, change, or swap with a neighbor to turn `a` into `b`; anything over `max` comes back as
 * `max + 1`, found early.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2]! + 1);
      row.push(d);
      least = Math.min(least, d);
    }
    if (least > max) return max + 1;
    before = prev;
    prev = row;
  }
  return Math.min(prev[b.length]!, max + 1);
}

/** Drop edition suffixes so "Mezzanine (Deluxe)" and "Discovery - Remastered 2011" match their base album. */
export function baseTitle(title: string): string {
  return title
    .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|deluxe|expanded|anniversary|edition|version|bonus).*$/i, '')
    .replace(/(\s*[([][^)\]]*[)\]])+\s*$/, '')
    .trim();
}

/** Key for matching an album across sources by artist + title. */
export function albumKey(artistName: string, albumTitle: string): string {
  return `${normalize(artistName)}|${normalize(baseTitle(albumTitle) || albumTitle)}`;
}

/** Lead artist of a credit: "Daft Punk feat. Pharrell Williams" → "Daft Punk". */
export function primaryArtist(credit: string): string {
  return credit.split(/\s+(?:feat\.?|featuring|ft\.)\s+|\s+&\s+|,\s+/i)[0]!.trim() || credit;
}
