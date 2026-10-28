/** Where an artist or album name leads, given whatever ids are known. */
interface ArtistRef {
  artistId?: number;
  artistMbid?: string;
  artistName: string;
}

/** Library page if owned, else the discover page; names alone go through a lookup first. */
export function artistHref({ artistId, artistMbid, artistName }: ArtistRef): string {
  if (artistId) return `/artists/${artistId}`;
  if (artistMbid) return `/discover/artists/${artistMbid}`;
  return `/discover/artist?${new URLSearchParams({ name: artistName })}`;
}

/** Owned albums open their page; others open the artist's discography with the album highlighted. */
export function albumHref(ref: ArtistRef & { albumId?: number; albumTitle: string }): string {
  if (ref.albumId) return `/albums/${ref.albumId}`;
  if (ref.artistMbid) return `/discover/artists/${ref.artistMbid}?${new URLSearchParams({ album: ref.albumTitle })}`;
  return `/discover/artist?${new URLSearchParams({ name: ref.artistName, album: ref.albumTitle })}`;
}

/** Loose album-title key, so "Mezzanine (Deluxe Edition)" finds "Mezzanine". */
export function titleKey(title: string): string {
  const key = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return key || title.trim().toLowerCase();
}
