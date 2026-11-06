import type { Account } from '@playarr/shared';
import { Dices, Pause, Play } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AccountMenu, accountName } from '../components/AccountMenu';
import { IconButton } from '../components/Button';
import { AlbumCard, ArtistAvatar, ArtistCard } from '../components/Cards';
import { Cover } from '../components/Cover';
import { LuckyButton } from '../components/LuckyButton';
import { MixCard } from '../components/Mixes';
import { SectionHeader, SHELF_CARD, Shelf } from '../components/Section';
import { CardSkeleton } from '../components/States';
import { TrackList } from '../components/TrackList';
import { cn } from '../lib/cn';
import { formatDuration } from '../lib/format';
import { useAlbums, useArtists, useFavorites, useHealth, useListeningStats, useMe, useMixes, usePlaylists, useRandomAlbums, useRecentAlbums } from '../lib/queries';
import { GRID } from './Albums';
import { FAVORITES } from './Favorites';
import { PlaylistCard } from './Playlists';
import { useClock, useCurrentTrack, usePlayer } from '../player/store';

export function HomePage() {
  const { data: health } = useHealth();
  const { data: recent } = useAlbums('added', 14);
  const { data: artists } = useArtists();
  const { data: favorites } = useFavorites();
  const { data: playlists } = usePlaylists();
  const [seed, setSeed] = useState(0);
  const { data: random, isFetching: rolling } = useRandomAlbums(12, seed);
  const lib = health?.library;

  return (
    <div className="px-5 pt-6 md:px-10 md:pt-14">
      <Greeting />

      <section className="relative mb-14 grid items-end gap-10 md:mb-20 xl:grid-cols-[1fr_auto]">
        <div className="animate-rise">
          <p className="max-w-md type-body leading-relaxed text-paper-dim">
            {lib ? (
              <>
                {lib.tracks} songs across {lib.albums} albums, {formatDuration(lib.durationSeconds)} of music
                waiting in your library.
              </>
            ) : (
              <span className="invisible">Loading library</span>
            )}
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <LuckyButton />
            <ListeningButton />
          </div>
        </div>
        <CoverStack albums={recent?.slice(0, 3)} />
      </section>

      <MadeForYou />
      <YearInReview />
      <JumpBackIn />

      {favorites && favorites.length > 0 && (
        <section className="mb-14 max-w-4xl">
          <SectionHeader kicker="Songs you love" title="Favorites" to="/favorites" />
          <div className="-mx-3">
            <TrackList tracks={favorites.slice(0, 5)} variant="mixed" source={FAVORITES} />
          </div>
        </section>
      )}

      {playlists && playlists.length > 0 && (
        <section className="mb-14">
          <SectionHeader kicker="Made by you" title="Playlists" to="/playlists" />
          <Shelf>
            {playlists.map((p, i) => (
              <PlaylistCard key={p.id} playlist={p} className={SHELF_CARD} style={stagger(i, 40)} />
            ))}
          </Shelf>
        </section>
      )}

      <section className="mb-14">
        <SectionHeader kicker="Just added" title="Recently added" to="/albums?sort=added" />
        <Shelf>
          {recent
            ? recent.map((a, i) => <AlbumCard key={a.id} album={a} className={SHELF_CARD} style={stagger(i, 40)} />)
            : Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} className={SHELF_CARD} />)}
        </Shelf>
      </section>

      <section className="mb-14">
        <SectionHeader kicker="The roster" title="Artists" to="/artists" />
        <Shelf>
          {shelfArtists(artists, recent).map((a, i) => (
            <ArtistCard key={a.id} artist={a} className={SHELF_CARD} style={stagger(i, 50)} />
          ))}
        </Shelf>
      </section>

      <section>
        <SectionHeader
          kicker="Pulled from the crates"
          title="Rediscover"
          action={
            <IconButton label="Reshuffle" onClick={() => setSeed((s) => s + 1)}>
              <Dices className={cn('size-4.5 transition-transform duration-500', rolling && 'rotate-180')} />
            </IconButton>
          }
        />
        <div className={GRID}>
          {random?.map((a, i) => (
            <AlbumCard key={a.id} album={a} style={stagger(i, 35)} />
          ))}
        </div>
      </section>
    </div>
  );
}

/** "Hi, Alex.": the account's name, else its username; before anyone has signed in (a new server), just hello. */
function greeting(account: Pick<Account, 'name' | 'username'> | undefined): string {
  return account ? `Hi, ${accountName(account)}.` : 'Hi there.';
}

/** Home's title: the account greeted by name, beside its avatar (Account and Settings), as on iOS. */
export function Greeting() {
  const { data: me, isPending } = useMe();
  return (
    <header className="mb-4 flex animate-rise items-center justify-between gap-4 md:mb-5">
      {/* Nothing until the account is known, rather than a greeting that changes as it arrives. */}
      <h1 className="min-w-0 type-page-title break-words text-paper">{isPending ? <span className="invisible">Hi.</span> : greeting(me)}</h1>
      {me && <AccountMenu account={me} />}
    </header>
  );
}

/**
 * Made for you: the generated mixes, first thing on Home. Hidden until there's at least one (a new
 * library has no tags or history yet, and the server is still making them).
 */
function MadeForYou() {
  const { data: mixes, isPending } = useMixes();
  if (!isPending && !mixes?.length) return null;
  return (
    <section className="mb-14">
      <SectionHeader kicker="Your mixes" title="Made for you" to="/mixes" />
      <Shelf>
        {mixes
          ? mixes.map((m, i) => <MixCard key={m.key} mix={m} className={SHELF_CARD} style={stagger(i, 40)} />)
          : Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} className={SHELF_CARD} />)}
      </Shelf>
    </section>
  );
}

/** The year that's ending (in December) or just ended (in January), if anything was played in it. */
export function reviewYear(now = new Date()): number | undefined {
  if (now.getMonth() === 11) return now.getFullYear();
  if (now.getMonth() === 0) return now.getFullYear() - 1;
  return undefined;
}

/** December and January: your year in music, a tap away. */
function YearInReview() {
  const year = reviewYear();
  const { data } = useListeningStats(String(year ?? 0) as `${number}`, year !== undefined);
  if (!year || !data?.plays || data.range !== String(year)) return null;
  const top = data.topArtists[0];
  return (
    <section className="mb-14">
      <Link
        to={`/settings/listening?range=${year}`}
        className="group relative flex items-center gap-5 overflow-hidden rounded-xl border border-line bg-ink-900 p-5 transition hover:border-paper/20 md:p-7"
      >
        {top && <ArtistAvatar name={top.artist.name} src={top.artist.imageUrl} size={128} className="size-24 shrink-0 md:size-32" />}
        <div className="min-w-0">
          <div className="type-kicker text-muted">Year in review</div>
          <div className="mt-1 font-display text-3xl text-paper md:text-5xl">Your {year} in music</div>
          <p className="mt-2 text-[14px] text-paper-dim">
            {data.minutes.toLocaleString()} minutes{top ? `, most of all ${top.artist.name}` : ''}
          </p>
        </div>
      </Link>
    </section>
  );
}

/** Jump back in: the albums heard lately, from the listening history. Hidden until there are a few. */
function JumpBackIn() {
  const { data: albums } = useRecentAlbums();
  if (!albums || albums.length < 3) return null;
  return (
    <section className="mb-14">
      <SectionHeader kicker="Heard lately" title="Jump back in" />
      <Shelf>
        {albums.map((a, i) => (
          <AlbumCard key={a.id} album={a} className={SHELF_CARD} style={stagger(i, 40)} />
        ))}
      </Shelf>
    </section>
  );
}

/** How many artists the home shelf shows; all of them are a tap away on Artists. */
const SHELF_ARTISTS = 20;

/**
 * The artists for the home shelf: those of the latest albums first, then those with the most albums.
 * The whole roster in one row meant hundreds of cards on the home page.
 */
export function shelfArtists<A extends { id: number; albumCount: number }>(artists: A[] | undefined, recent: { artistId: number }[] | undefined): A[] {
  if (!artists) return [];
  const byId = new Map(artists.map((a) => [a.id, a]));
  const picked = new Map<number, A>();
  for (const album of recent ?? []) {
    const artist = byId.get(album.artistId);
    if (artist) picked.set(artist.id, artist);
  }
  for (const a of [...artists].sort((x, y) => y.albumCount - x.albumCount)) {
    if (picked.size >= SHELF_ARTISTS) break;
    picked.set(a.id, a);
  }
  return [...picked.values()].slice(0, SHELF_ARTISTS);
}

/**
 * Cards rise in one after another, but only the first few: a long stagger keeps content appearing for
 * seconds, and phones take a tap while things appear as a hover, so the link needs a second tap.
 */
const stagger = (i: number, stepMs: number) => ({ animationDelay: `${Math.min(i, 8) * stepMs}ms` });

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
            <Cover src={a.coverUrl} size={208} alt={a.title} eager className="rounded-cover shadow-cover-hero ring-1 ring-paper/10" />
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * The listening session, beside Feeling lucky: paused, "Resume" and the song's title beside its cover with a play sign;
 * playing, just the cover, round, ringed by how far into the song it is, with a pause sign. It draws in and out
 * between the two, as the iOS app's Home does.
 */
function ListeningButton() {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const toggle = usePlayer((s) => s.toggle);
  if (!track) return null;
  const spring = { type: 'spring', duration: 0.4, bounce: 0.15 } as const;
  return (
    <motion.button
      layout
      type="button"
      onClick={toggle}
      transition={spring}
      // Set here rather than as a class, so the layout animation keeps it round while the pill narrows.
      style={{ borderRadius: 999 }}
      aria-label={playing ? `Pause ${track.title}` : `Resume ${track.title}`}
      className={cn(
        'inline-flex h-12 max-w-full items-center gap-3 overflow-hidden border border-line bg-paper/[0.03] p-[3px] text-left transition-colors hover:bg-paper/[0.07]',
        !playing && 'pr-5',
      )}
    >
      <motion.span layout="position" transition={spring} className="relative grid size-10 shrink-0 place-items-center">
        <Cover src={track.coverUrl} size={36} alt="" className="size-[34px] rounded-full" />
        {playing && <ProgressRing />}
        <span className="absolute inset-[3px] grid place-items-center rounded-full bg-black/45">
          {playing ? <Pause className="size-3.5 fill-white text-white" /> : <Play className="size-3.5 translate-x-px fill-white text-white" />}
        </span>
      </motion.span>
      <AnimatePresence initial={false} mode="popLayout">
        {!playing && (
          <motion.span
            key="resume"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={spring}
            className="min-w-0"
          >
            <span className="block font-mono text-[10px] tracking-[0.2em] text-muted uppercase">Resume</span>
            <span className="block max-w-56 truncate text-sm text-paper">{track.title}</span>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

const RING_R = 19;
const RING_LENGTH = 2 * Math.PI * RING_R;

/** How far into the song it is, as a ring round the cover. Its own component: the clock ticks many times a second. */
function ProgressRing() {
  const time = useClock((s) => s.time);
  const duration = useClock((s) => s.duration);
  const done = duration > 0 ? Math.min(1, time / duration) : 0;
  return (
    <svg viewBox="0 0 40 40" className="pointer-events-none absolute inset-0 size-10 -rotate-90" aria-hidden>
      <circle cx="20" cy="20" r={RING_R} fill="none" strokeWidth="2" className="stroke-paper/15" />
      <circle
        cx="20"
        cy="20"
        r={RING_R}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${RING_LENGTH * done} ${RING_LENGTH}`}
        className="stroke-accent"
      />
    </svg>
  );
}
