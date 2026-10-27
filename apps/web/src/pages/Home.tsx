import { Dices, Play, Shuffle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AlbumCard, ArtistCard } from '../components/Cards';
import { Cover } from '../components/Cover';
import { Wordmark } from '../components/Nav';
import { SectionHeader, Shelf, Skeleton } from '../components/Section';
import { formatDuration, greeting } from '../lib/format';
import { useAlbums, useArtists, useHealth, useRandomAlbums } from '../lib/queries';
import { shuffleLibrary } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';

export function HomePage() {
  const { data: health } = useHealth();
  const { data: recent } = useAlbums('added', 14);
  const { data: artists } = useArtists();
  const [seed, setSeed] = useState(0);
  const { data: random, isFetching: rolling } = useRandomAlbums(12, seed);
  const lib = health?.library;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="px-5 pt-6 md:px-10 md:pt-14">
      <div className="mb-8 md:hidden">
        <Wordmark />
      </div>

      <section className="relative mb-14 grid items-end gap-10 md:mb-20 xl:grid-cols-[1fr_auto]">
        <div className="animate-rise">
          <div className="font-mono text-[11px] tracking-[0.25em] text-muted uppercase">{today}</div>
          <h1 className="mt-3 font-display text-[3.25rem] leading-[0.95] tracking-tight text-paper md:text-[5.5rem]">
            {greeting()}
            <span className="text-accent">.</span>
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-paper-dim/80">
            {lib ? (
              <>
                {lib.tracks} tracks across {lib.albums} albums, {formatDuration(lib.durationSeconds)} of music
                waiting in your Lidarr library.
              </>
            ) : (
              <span className="invisible">Loading library</span>
            )}
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void shuffleLibrary()}
              className="inline-flex h-12 items-center gap-2.5 rounded-full bg-accent pr-6 pl-5 font-medium text-accent-ink shadow-[0_10px_40px_-10px_var(--accent)] transition hover:brightness-110 active:scale-[0.98]"
            >
              <Shuffle className="size-[18px]" /> Shuffle everything
            </button>
            <ResumeButton />
          </div>
        </div>
        <CoverStack albums={recent?.slice(0, 3)} />
      </section>

      <section className="mb-14">
        <SectionHeader kicker="Fresh from Lidarr" title="Recently added" to="/albums?sort=added" />
        <Shelf>
          {recent
            ? recent.map((a, i) => (
                <AlbumCard key={a.id} album={a} size={200} className="w-[42vw] max-w-52 shrink-0 snap-start sm:w-44 md:w-52" style={{ animationDelay: `${i * 40}ms` }} />
              ))
            : Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-square w-[42vw] max-w-52 shrink-0 sm:w-44 md:w-52" />)}
        </Shelf>
      </section>

      <section className="mb-14">
        <SectionHeader kicker="The roster" title="Artists" to="/artists" />
        <Shelf>
          {artists?.map((a, i) => (
            <ArtistCard key={a.id} artist={a} className="w-[40vw] max-w-48 shrink-0 snap-start sm:w-40 md:w-48" style={{ animationDelay: `${i * 50}ms` }} />
          ))}
        </Shelf>
      </section>

      <section>
        <SectionHeader
          kicker="Pulled from the crates"
          title="Rediscover"
          action={
            <button
              type="button"
              onClick={() => setSeed((s) => s + 1)}
              aria-label="Reshuffle"
              className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper"
            >
              <Dices className={`size-[18px] transition-transform duration-500 ${rolling ? 'rotate-180' : ''}`} />
            </button>
          }
        />
        <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:gap-x-6 lg:grid-cols-4 xl:grid-cols-6">
          {random?.map((a, i) => (
            <AlbumCard key={a.id} album={a} style={{ animationDelay: `${i * 35}ms` }} />
          ))}
        </div>
      </section>
    </div>
  );
}

/** Three recent covers fanned out like records on a table. */
function CoverStack({ albums }: { albums?: { id: number; title: string; coverUrl?: string }[] }) {
  if (!albums?.length) return null;
  const poses = [
    'rotate-[-8deg] translate-x-10 translate-y-4',
    'rotate-[4deg] -translate-x-2 -translate-y-2 z-10',
    'rotate-[14deg] -translate-x-16 translate-y-6',
  ];
  return (
    <div className="hidden xl:block">
      <div className="flex justify-end pr-6">
        {albums.map((a, i) => (
          <Link
            key={a.id}
            to={`/albums/${a.id}`}
            className={`group relative -ml-16 block w-40 animate-rise transition duration-500 ease-out-expo hover:z-20 hover:-translate-y-3 hover:rotate-0 2xl:w-52 ${poses[i]}`}
            style={{ animationDelay: `${150 + i * 90}ms` }}
          >
            <Cover src={a.coverUrl} size={208} alt={a.title} eager className="rounded-[4px] shadow-[0_30px_60px_-15px_rgb(0_0_0/0.9)] ring-1 ring-paper/10" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function ResumeButton() {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const toggle = usePlayer((s) => s.toggle);
  if (!track || playing) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex h-12 max-w-full items-center gap-3 rounded-full border border-line bg-paper/[0.03] pr-5 pl-1.5 text-left transition hover:bg-paper/[0.07]"
    >
      <Cover src={track.coverUrl} size={36} alt="" className="size-9 shrink-0 rounded-full" />
      <span className="min-w-0">
        <span className="block font-mono text-[10px] tracking-[0.2em] text-muted uppercase">Resume</span>
        <span className="block max-w-56 truncate text-sm text-paper">{track.title}</span>
      </span>
      <Play className="size-4 shrink-0 fill-paper text-paper" />
    </button>
  );
}
