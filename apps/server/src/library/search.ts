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
