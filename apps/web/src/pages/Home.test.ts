import { describe, expect, it } from 'vitest';
import { shelfArtists } from './Home';

describe('shelfArtists', () => {
  it('shows the artists of the latest albums first, then the biggest, never the whole roster', () => {
    const artists = Array.from({ length: 300 }, (_, i) => ({ id: i, albumCount: i % 7 }));
    const shelf = shelfArtists(artists, [{ artistId: 250 }, { artistId: 3 }, { artistId: 250 }]);
    expect(shelf).toHaveLength(20);
    expect(shelf.slice(0, 2).map((a) => a.id)).toEqual([250, 3]);
    expect(shelf.slice(2).every((a) => a.albumCount === 6)).toBe(true);
  });
});
