import { Search as SearchIcon, SearchX, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, IconButton } from '../components/Button';
import { AlbumCard, ArtistAvatar, ArtistCard, DiscoverArtistCard } from '../components/Cards';
import { DiscoverAlbumCard, DiscoverTrackRow, RequestsPill } from '../components/Discover';
import { SectionHeader, SHELF_CARD, Shelf } from '../components/Section';
import { EmptyState, InlineError, SongRowsSkeleton } from '../components/States';
import { TrackList } from '../components/TrackList';
import { activeRequestCount, useArtists, useDiscover, useHasLidarr, usePlaylists, useRequests, useSearch } from '../lib/queries';
import { useDebounced } from '../lib/useDebounced';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const deferred = useDeferredValue(q.trim());
  const { data, isFetching } = useSearch(deferred);
  const input = useRef<HTMLInputElement>(null);
  const { data: requests } = useRequests();
  const hasLidarr = useHasLidarr();
  const { data: playlists } = usePlaylists();
  const [allTracks, setAllTracks] = useState(false);
  useEffect(() => setAllTracks(false), [deferred]);
  const want = fold(deferred);
  const playlistHits = want ? (playlists ?? []).filter((p) => fold(p.name).includes(want)).slice(0, 8) : [];

  useEffect(() => {
    input.current?.focus();
  }, []);
  const clear = () => {
    setParams({}, { replace: true });
    input.current?.focus();
  };

  const empty = data && !data.artists.length && !data.albums.length && !data.tracks.length && !playlistHits.length;
  const top = data?.artists[0] ?? null;

  return (
    <div className="px-5 pt-6 md:px-10 md:pt-14">
      <div className="sticky top-0 z-20 -mx-5 bg-ink-900/85 px-5 pt-[env(safe-area-inset-top)] pb-4 backdrop-blur-xl md:-mx-10 md:px-10">
        <label className="group relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-0 size-6 text-muted transition group-focus-within:text-accent md:size-8" />
          <input
            ref={input}
            type="search"
            value={q}
            onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
            placeholder="Search music"
            aria-label="Search music"
            autoComplete="off"
            spellCheck={false}
            className="h-16 w-full border-b border-line bg-transparent pr-10 pl-10 font-display text-3xl text-paper placeholder:text-ink-600 focus:border-accent focus:outline-none md:h-20 md:pl-14 md:text-5xl [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <IconButton label="Clear search" onClick={clear} className="absolute right-0">
              <X className="size-5" />
            </IconButton>
          )}
          <span
            className="absolute bottom-0 left-0 h-px bg-accent transition-all duration-500 ease-out-expo"
            style={{ width: isFetching ? '100%' : '0%', opacity: isFetching ? 1 : 0 }}
          />
        </label>
      </div>

      {activeRequestCount(requests) > 0 && (
        <div className="mt-4">
          <RequestsPill count={activeRequestCount(requests)} />
        </div>
      )}

      {!deferred && <BrowseArtists />}

      {empty && (
        <EmptyState
          icon={SearchX}
          title="Not in your crates."
          hint={`Nothing in your library matches “${deferred}”.${hasLidarr ? ' Here’s what’s out there:' : ''}`}
          // Without Lidarr there's nothing further down: back to the artists to try.
          action={hasLidarr ? undefined : { label: 'Clear search', icon: <X />, onClick: clear }}
          className="py-10 md:py-12"
        />
      )}

      {data && !empty && deferred && (
        <div className="mt-6 space-y-12">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,380px)_1fr]">
            {top && (
              <section>
                <SectionHeader title="Top result" />
                <Link
                  to={`/artists/${top.id}`}
                  className="group flex items-center gap-5 rounded-lg border border-line bg-paper/[0.025] p-5 transition hover:bg-paper/[0.05]"
                >
                  <ArtistAvatar name={top.name} src={top.imageUrl} size={112} className="size-28 shrink-0 shadow-xl" />
                  <div className="min-w-0">
                    <div className="font-display text-3xl leading-tight text-paper">{top.name}</div>
                    <div className="mt-1 type-kicker text-muted">Artist</div>
                  </div>
                </Link>
              </section>
            )}
            {data.tracks.length > 0 && (
              <section className={top ? '' : 'lg:col-span-2'}>
                <SectionHeader title="Songs" />
                <div className="-mx-3">
                  <TrackList tracks={allTracks ? data.tracks : data.tracks.slice(0, 6)} variant="mixed" />
                </div>
                {!allTracks && data.tracks.length > 6 && (
                  <Button variant="ghost" size="small" onClick={() => setAllTracks(true)} className="mt-2">
                    Show all {data.tracks.length} songs
                  </Button>
                )}
              </section>
            )}
          </div>

          {playlistHits.length > 0 && (
            <section>
              <SectionHeader title="Playlists" />
              <div className="flex flex-wrap gap-2">
                {playlistHits.map((p) => (
                  <Link
                    key={p.id}
                    to={`/playlists/${p.id}`}
                    className="rounded-full border border-line px-4 py-2 text-sm text-paper transition hover:border-accent"
                  >
                    {p.name} <span className="font-mono text-[11px] text-muted">· {p.trackCount}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {data.albums.length > 0 && (
            <section>
              <SectionHeader title="Albums" />
              <Shelf>
                {data.albums.map((a) => (
                  <AlbumCard key={a.id} album={a} className={SHELF_CARD} />
                ))}
              </Shelf>
            </section>
          )}

          {data.artists.length > 1 && (
            <section>
              <SectionHeader title="Artists" />
              <Shelf>
                {data.artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} className={SHELF_CARD} />
                ))}
              </Shelf>
            </section>
          )}
        </div>
      )}

      {deferred && hasLidarr && <DiscoverSection q={deferred} />}
    </div>
  );
}

/** Music that isn't in the library: search Lidarr/MusicBrainz/Deezer and request albums. */
function DiscoverSection({ q }: { q: string }) {
  const debounced = useDebounced(q, 450);
  const { data, isFetching, error, refetch } = useDiscover(debounced);
  // Albums already in the library appear in the results above.
  const albums = data?.albums.filter((a) => a.availability.state !== 'available') ?? [];
  const artists = data?.artists.filter((a) => !a.artistId) ?? [];
  const tracks = data?.tracks ?? [];
  const nothing = data && !albums.length && !artists.length && !tracks.length;
  const loading = !data && (isFetching || debounced !== q);

  return (
    <section className="mt-16 border-t border-line pt-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 type-kicker text-muted">Lidarr · MusicBrainz · Deezer</div>
          <h2 className="flex items-center gap-3 font-display text-3xl leading-none text-paper md:text-4xl">
            Not in your library
            {isFetching && <span className="size-2 animate-pulse rounded-full bg-accent" aria-label="Searching" />}
          </h2>
        </div>
        <p className="max-w-sm type-small text-muted">
          Request an album and Lidarr will search your indexers for it. It shows up here when it’s ready.
        </p>
      </div>

      {loading && <SongRowsSkeleton count={4} className="-mx-3 max-w-4xl" />}
      {error && !data && (
        <InlineError error={error} onRetry={() => void refetch()} retrying={isFetching}>
          Couldn’t search beyond your library
        </InlineError>
      )}
      {nothing && <p className="text-sm text-muted">Nothing found for “{debounced}”.</p>}

      <div className="space-y-12">
        {tracks.length > 0 && (
          <div>
            <SectionHeader title="Songs" kicker="Request the album it’s on" />
            <ol className="-mx-3 max-w-4xl">
              {tracks.slice(0, 8).map((t) => (
                <DiscoverTrackRow key={t.id} track={t} />
              ))}
            </ol>
          </div>
        )}
        {albums.length > 0 && (
          <div>
            <SectionHeader title="Albums" />
            <Shelf>
              {albums.map((a, i) => (
                <DiscoverAlbumCard key={a.mbid} album={a} className={SHELF_CARD} style={{ animationDelay: `${i * 30}ms` }} />
              ))}
            </Shelf>
          </div>
        )}
        {artists.length > 0 && (
          <div>
            <SectionHeader title="Artists" />
            <Shelf>
              {artists.map((a, i) => (
                <DiscoverArtistCard key={a.mbid} artist={a} className={SHELF_CARD} style={{ animationDelay: `${i * 40}ms` }} />
              ))}
            </Shelf>
          </div>
        )}
      </div>
    </section>
  );
}

/** Case- and accent-insensitive text, for matching playlist names. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** How many artists the empty search page suggests: the whole roster is a wall of pills on a phone. */
const SUGGESTED_ARTISTS = 24;

/** Empty state: the artists with the most music, each a tap away from its page. */
function BrowseArtists() {
  const { data: artists } = useArtists();
  if (!artists?.length) return null;
  const suggested = [...artists].sort((a, b) => b.albumCount - a.albumCount || b.trackCount - a.trackCount).slice(0, SUGGESTED_ARTISTS);
  return (
    <div className="mt-8">
      <div className="mb-4 type-kicker text-muted">Try an artist</div>
      <div className="flex flex-wrap gap-2">
        {suggested.map((a) => (
          <Link
            key={a.id}
            to={`/artists/${a.id}`}
            className="rounded-full border border-line px-4 py-2 text-sm text-paper-dim transition hover:border-accent hover:text-paper"
          >
            {a.name}
          </Link>
        ))}
        {artists.length > SUGGESTED_ARTISTS && (
          <Link to="/artists" className="rounded-full px-4 py-2 text-sm text-accent hover:underline">
            All {artists.length} artists
          </Link>
        )}
      </div>
    </div>
  );
}
