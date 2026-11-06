import type { DiscoverResults } from '@playarr/shared';
import { History, Search as SearchIcon, SearchX, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, IconButton } from '../components/Button';
import { AlbumCard, ArtistAvatar, ArtistCard, DiscoverArtistCard } from '../components/Cards';
import { DiscoverAlbumCard, DiscoverTrackRow, RequestsPill } from '../components/Discover';
import { SectionHeader, SHELF_CARD, Shelf } from '../components/Section';
import { ListRow } from '../components/SongRow';
import { EmptyState, InlineError, SongRowsSkeleton } from '../components/States';
import { TrackList } from '../components/TrackList';
import { activeRequestCount, useArtists, useDiscover, useHasLidarr, useMe, usePlaylists, useRequests, useRequestsEnabled, useSearch } from '../lib/queries';
import { clearSearches, forgetSearch, recordSearch, restoreSearches, SETTLED_MS, useRecents } from '../lib/recentSearches';
import { toastWithUndo } from '../lib/toast';
import { useDebounced } from '../lib/useDebounced';

/** Beyond the library, only what isn't in it: albums already here appear in the library's results above. */
function beyondHits(data: DiscoverResults | undefined) {
  return {
    albums: data?.albums.filter((a) => a.availability.state !== 'available') ?? [],
    artists: data?.artists.filter((a) => !a.artistId) ?? [],
    tracks: data?.tracks ?? [],
  };
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const deferred = useDeferredValue(q.trim());
  const { data, isFetching } = useSearch(deferred);
  const input = useRef<HTMLInputElement>(null);
  const { data: requests } = useRequests();
  const { data: playlists } = usePlaylists();
  // Recent searches are each account's own, on this device.
  const account = String(useMe().data?.id ?? '');
  const [allTracks, setAllTracks] = useState(false);
  useEffect(() => setAllTracks(false), [deferred]);
  const want = fold(deferred);
  const playlistHits = want ? (playlists ?? []).filter((p) => fold(p.name).includes(want)).slice(0, 8) : [];

  // Beyond the library (Lidarr, else MusicBrainz, and Deezer for songs), asked once typing pauses.
  const beyondQuery = useDebounced(deferred, 450);
  const beyond = useDiscover(beyondQuery);
  const hits = beyondHits(beyond.data);
  const anyBeyond = hits.albums.length + hits.artists.length + hits.tracks.length > 0;
  const asksBeyond = deferred.length >= 2;
  // The answer is for what's typed now, not the last one, kept on screen while the next is fetched.
  const beyondAnswered = asksBeyond && beyondQuery === deferred && !!beyond.data && !beyond.isPlaceholderData;
  const beyondFailed = asksBeyond && beyondQuery === deferred && beyond.isError && !beyond.isFetching && !beyondAnswered;
  const nothingBeyond = !asksBeyond || (beyondAnswered && !anyBeyond);

  useEffect(() => {
    input.current?.focus();
  }, []);
  // A search counts once it's been left alone a moment; opening a result or pressing Enter counts at once.
  useEffect(() => {
    if (deferred.length < 2) return;
    const id = setTimeout(() => recordSearch(account, deferred), SETTLED_MS);
    return () => clearTimeout(id);
  }, [deferred, account]);
  const record = () => recordSearch(account, q);
  const recordOnOpen = (e: MouseEvent) => {
    if ((e.target as Element).closest('a, button')) record();
  };
  const search = (text: string) => setParams(text ? { q: text } : {}, { replace: true });
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
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && record()}
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

      {!deferred && (
        <>
          <RecentSearches
            account={account}
            onPick={(text) => {
              search(text);
              recordSearch(account, text);
            }}
          />
          <BrowseArtists />
        </>
      )}

      {empty &&
        (nothingBeyond || beyondFailed ? (
          // Nothing here, and nothing beyond either (or no way to look): what to try next.
          <>
            <EmptyState
              icon={SearchX}
              title="Not in your crates."
              hint={
                asksBeyond && nothingBeyond
                  ? `Nothing in your library or beyond it matches “${deferred}”. Check the spelling, try fewer words, or pick an artist you have.`
                  : `Nothing in your library matches “${deferred}”.`
              }
              // Back to the recent searches and the artists to try, the field ready to type in.
              action={{ label: 'New search', icon: <SearchIcon />, onClick: clear }}
              className="py-10 md:py-12"
            />
            {nothingBeyond && <BrowseArtists />}
          </>
        ) : (
          <EmptyState
            icon={SearchX}
            title="Not in your crates."
            hint={`Nothing in your library matches “${deferred}”. Here’s what’s out there:`}
            className="py-10 md:py-12"
          />
        ))}

      {/* Opening or playing anything in the results makes the search one of the recent ones. */}
      <div onClickCapture={recordOnOpen}>
        {data && !empty && deferred && data.near && (
          // Nothing matched as typed: these are a letter or two away, and say so, so nobody takes them for exact.
          <p className="mt-6 type-body text-paper-dim">
            Nothing called “<span className="text-paper">{deferred}</span>”. These come close:
          </p>
        )}
        {data && !empty && deferred && (
          <div className="mt-6 space-y-12">
            <div className="grid gap-10 page-lg:grid-cols-[minmax(0,380px)_1fr]">
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
                <section className={top ? '' : 'page-lg:col-span-2'}>
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
                      {p.name} <span className="type-meta text-muted">· {p.trackCount}</span>
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

        {/* Beyond the library, with or without Lidarr, whenever there's something there (or on its way). */}
        {!nothingBeyond && (
          <Beyond
            hits={hits}
            fetching={beyond.isFetching}
            error={beyondFailed ? beyond.error : null}
            onRetry={() => void beyond.refetch()}
            continues={!!empty}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Music that isn't in the library: Lidarr's search, else MusicBrainz's, with Deezer for songs. Marked as not in your
 * library; Request shows where requesting is possible (RequestButton decides), and nothing in its place otherwise.
 * Plan 6 §7 would offer "Ask {owner}" instead, which waits on requests that remember who asked (plan 4 §4).
 */
function Beyond({
  hits: { albums, artists, tracks },
  fetching,
  error,
  onRetry,
  continues,
}: {
  /** What's out there; none yet while the first answer is on its way. */
  hits: ReturnType<typeof beyondHits>;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  /** It follows "Here's what's out there:" straight on, rather than results of the library's own. */
  continues: boolean;
}) {
  const hasLidarr = useHasLidarr();
  const requestsOn = useRequestsEnabled();
  return (
    <section aria-label="Not in your library" className={continues ? 'mt-2' : 'mt-16 border-t border-line pt-10'}>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 type-kicker text-muted">{hasLidarr ? 'Lidarr · MusicBrainz · Deezer' : 'MusicBrainz · Deezer'}</div>
          <h2 className="flex items-center gap-3 font-display text-3xl leading-none text-paper md:text-4xl">
            Not in your library
            {fetching && <span className="size-2 animate-pulse rounded-full bg-accent" aria-label="Searching" />}
          </h2>
        </div>
        <p className="max-w-sm type-small text-muted">
          {requestsOn
            ? 'Request an album and Lidarr will search your indexers for it. It lands in your library when it’s ready.'
            : 'Music from MusicBrainz and Deezer that isn’t in your library yet.'}
        </p>
      </div>

      {error ? (
        <InlineError error={error} onRetry={onRetry} retrying={fetching}>
          Couldn’t search beyond your library
        </InlineError>
      ) : !albums.length && !artists.length && !tracks.length ? (
        <SongRowsSkeleton count={4} className="-mx-3 max-w-4xl" />
      ) : (
        <div className="space-y-12">
          {tracks.length > 0 && (
            <div>
              <SectionHeader title="Songs" kicker={requestsOn ? 'Request the album it’s on' : undefined} />
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
      )}
    </section>
  );
}

/** Case- and accent-insensitive text, for matching playlist names. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** The empty search page's first offer: what this account searched for lately on this device, each a tap away. */
function RecentSearches({ account, onPick }: { account: string; onPick: (query: string) => void }) {
  const recents = useRecents(account);
  if (!recents.length) return null;
  // Taking one, or all, off the list happens at once, with Undo (docs/design.md, Taking things back).
  const remove = (query: string) => {
    forgetSearch(account, query);
    toastWithUndo(`Removed “${query}” from recent searches`, () => restoreSearches(account, recents));
  };
  const clearAll = () => {
    clearSearches(account);
    toastWithUndo('Cleared recent searches', () => restoreSearches(account, recents));
  };
  return (
    <section aria-labelledby="recent-searches" className="mt-8 max-w-2xl">
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 id="recent-searches" className="type-kicker text-muted">
          Recent searches
        </h2>
        <Button variant="ghost" size="small" onClick={clearAll}>
          Clear
        </Button>
      </div>
      <ul className="-mx-3">
        {recents.map((query) => (
          <ListRow
            key={query}
            lead={<History aria-hidden className="size-4.5 shrink-0 text-muted" />}
            title={query}
            main={{ label: `Search for “${query}”`, onClick: () => onPick(query) }}
            trailing={
              <IconButton label={`Remove “${query}” from recent searches`} onClick={() => remove(query)} className="z-10">
                <X className="size-4" />
              </IconButton>
            }
          />
        ))}
      </ul>
    </section>
  );
}

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
