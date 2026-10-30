import { Navigate, Link, useSearchParams } from 'react-router';
import { Skeleton } from '../components/Section';
import { SlowLookup } from '../components/SlowLookup';
import { albumHref, artistHref } from '../lib/links';
import { useArtistLookup } from '../lib/queries';

/** Songs from outside the library only know an artist's name: resolve it, then forward. */
export function FindArtistPage() {
  const [params] = useSearchParams();
  const name = params.get('name') ?? '';
  const album = params.get('album');
  const { data, error } = useArtistLookup(name);

  if (data) {
    const ref = { artistId: data.artistId, artistMbid: data.mbid, artistName: name };
    return <Navigate replace to={album ? albumHref({ ...ref, albumTitle: album }) : artistHref(ref)} />;
  }
  return (
    <div className="px-5 pt-10 md:px-10 md:pt-16">
      <div className="font-mono text-[11px] tracking-[0.25em] text-paper-dim/80 uppercase">Artist</div>
      <h1 className="mt-3 font-display text-5xl leading-[0.95] tracking-tight text-paper md:text-7xl">{name}</h1>
      {error || !name ? (
        <div className="mt-6 max-w-md text-sm text-muted">
          <p>{error instanceof Error ? error.message : 'No artist given.'}</p>
          {name && (
            <Link to={`/search?${new URLSearchParams({ q: name })}`} className="mt-3 inline-block text-accent hover:underline">
              Search for “{name}” instead
            </Link>
          )}
        </div>
      ) : (
        <>
          <p className="mt-5 font-mono text-[12px] text-muted">Looking them up on MusicBrainz…</p>
          <SlowLookup active what={`“${name}”`} className="mt-3" />
          <Skeleton className="mt-10 h-48 w-full max-w-3xl" />
        </>
      )}
    </div>
  );
}
