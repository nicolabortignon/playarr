import { Search as SearchIcon, X } from 'lucide-react';
import { useDeferredValue, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlbumCard, ArtistCard } from '../components/Cards';
import { Cover } from '../components/Cover';
import { SectionHeader, Shelf } from '../components/Section';
import { TrackList } from '../components/TrackList';
import { useArtists, useSearch } from '../lib/queries';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const deferred = useDeferredValue(q.trim());
  const { data, isFetching } = useSearch(deferred);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const empty = data && !data.artists.length && !data.albums.length && !data.tracks.length;
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
            placeholder="Artists, albums, tracks"
            aria-label="Search your library"
            autoComplete="off"
            spellCheck={false}
            className="h-16 w-full border-b border-line bg-transparent pr-10 pl-10 font-display text-3xl text-paper placeholder:text-ink-600 focus:border-accent focus:outline-none md:h-20 md:pl-14 md:text-5xl [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setParams({}, { replace: true });
                input.current?.focus();
              }}
              className="absolute right-0 grid size-9 place-items-center rounded-full text-muted hover:text-paper"
            >
              <X className="size-5" />
            </button>
          )}
          <span
            className="absolute bottom-0 left-0 h-px bg-accent transition-all duration-500 ease-out-expo"
            style={{ width: isFetching ? '100%' : '0%', opacity: isFetching ? 1 : 0 }}
          />
        </label>
      </div>

      {!deferred && <BrowseArtists />}

      {empty && (
        <div className="mt-20 text-center">
          <div className="font-display text-3xl text-paper">Nothing in the crates.</div>
          <p className="mt-2 text-sm text-muted">No matches for “{deferred}” in your library.</p>
        </div>
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
                  <Cover src={top.imageUrl} size={112} alt={top.name} className="size-28 shrink-0 rounded-full shadow-xl" />
                  <div className="min-w-0">
                    <div className="font-display text-3xl leading-tight text-paper">{top.name}</div>
                    <div className="mt-1 font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Artist</div>
                  </div>
                </Link>
              </section>
            )}
            {data.tracks.length > 0 && (
              <section className={top ? '' : 'lg:col-span-2'}>
                <SectionHeader title="Tracks" />
                <div className="-mx-3">
                  <TrackList tracks={data.tracks.slice(0, 6)} variant="mixed" />
                </div>
              </section>
            )}
          </div>

          {data.albums.length > 0 && (
            <section>
              <SectionHeader title="Albums" />
              <Shelf>
                {data.albums.map((a) => (
                  <AlbumCard key={a.id} album={a} size={180} className="w-[40vw] max-w-44 shrink-0 snap-start sm:w-40 md:w-44" />
                ))}
              </Shelf>
            </section>
          )}

          {data.artists.length > 1 && (
            <section>
              <SectionHeader title="Artists" />
              <Shelf>
                {data.artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} className="w-[40vw] max-w-44 shrink-0 snap-start sm:w-40 md:w-44" />
                ))}
              </Shelf>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Empty state: browse by genre-tagged artists. */
function BrowseArtists() {
  const { data: artists } = useArtists();
  const genres = [...new Set(artists?.flatMap((a) => a.genres.slice(0, 2)) ?? [])].slice(0, 12);
  const [, setParams] = useSearchParams();
  if (!artists) return null;
  return (
    <div className="mt-8">
      <div className="mb-4 font-mono text-[11px] tracking-[0.25em] text-muted uppercase">Try an artist</div>
      <div className="flex flex-wrap gap-2">
        {artists.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setParams({ q: a.name }, { replace: true })}
            className="rounded-full border border-line px-4 py-2 text-sm text-paper-dim transition hover:border-accent hover:text-paper"
          >
            {a.name}
          </button>
        ))}
      </div>
      {genres.length > 0 && (
        <p className="mt-10 max-w-xl font-display text-2xl leading-snug text-ink-600 md:text-3xl">
          {genres.join(' · ')}
        </p>
      )}
    </div>
  );
}
