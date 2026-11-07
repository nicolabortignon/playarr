const ASCII = /^[\x00-\x7f]*$/;

/** Lowercase, strip diacritics and punctuation so "L’Impératrice" matches "limperatrice". */
export function normalize(s: string): string {
  // Plain ASCII, most names, has no accents to strip and no letters or digits beyond a–z and 0–9: the same
  // result as below, several times faster, which a library of 100,000 songs feels.
  if (ASCII.test(s)) return s.toLowerCase().replace(/['`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * How well each text matches `query` (both normalized), as scoreMatch scores one: for scoring many texts against
 * one query, with the query's parts worked out once.
 */
export function matchScorer(query: string): (text: string) => number {
  const spaced = ` ${query}`;
  const words = query.split(' ');
  const several = words.length > 1;
  return (t) => {
    if (!t) return 0;
    if (t === query) return 100;
    if (t.startsWith(query)) return 80;
    if (t.includes(spaced)) return 60;
    if (t.includes(query)) return 40;
    // Every query word appears somewhere (e.g. "punk daft").
    return several && words.every((w) => t.includes(w)) ? 20 : 0;
  };
}

/** 0 = no match; higher is better. `query` must already be normalized. */
export function scoreMatch(query: string, text: string): number {
  return matchScorer(query)(normalize(text));
}

/**
 * How near each text is to `query` (both normalized), as scoreNearMatch scores one, for scoring many texts. Only
 * the words of a text about as long as a query word are compared letter by letter, and a text run together only
 * when its length is close: the same scores, without taking every name apart.
 */
export function nearScorer(query: string): (text: string) => number {
  const joined = query.replaceAll(' ', '');
  const joinedSlack = slack(joined);
  const words = query.split(' ').map((q) => ({ q, max: slack(q) }));
  return (t) => {
    if (!t) return 0;
    let spaces = 0;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 32) spaces++;
    if (Math.abs(t.length - spaces - joined.length) <= joinedSlack) {
      const whole = editDistance(joined, spaces ? t.replaceAll(' ', '') : t, joinedSlack);
      if (whole <= joinedSlack) return 10 - whole;
    }
    let off = 0;
    for (const { q, max } of words) {
      let best = max + 1;
      for (let start = 0; start <= t.length && best > 0; ) {
        let end = t.indexOf(' ', start);
        if (end === -1) end = t.length;
        if (Math.abs(end - start - q.length) <= max) best = Math.min(best, editDistance(q, t.slice(start, end), max));
        start = end + 1;
      }
      if (best > max) return 0;
      off += best;
    }
    return 10 - off;
  };
}

/**
 * 0 = not near; higher is closer. For a query that matches nothing as typed (`query` normalized): each of its words
 * within a letter or two of a word of `text` ("radiohed" finds Radiohead, "massive atack" Massive Attack), or the
 * whole query within a few letters of the whole text, run together ("daftpunk", "radio head").
 */
export function scoreNearMatch(query: string, text: string): number {
  return nearScorer(query)(normalize(text));
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
