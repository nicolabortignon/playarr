import type { ListeningStats, StatsRange } from '@playarr/shared';
import { ChartColumn, Play } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { AlbumCard, ArtistAvatar } from '../components/Cards';
import { ColumnChart } from '../components/ColumnChart';
import { InlineLink } from '../components/InlineLink';
import { NameAndNumbers } from '../components/NameAndNumbers';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { SongRow } from '../components/SongRow';
import { Choice } from '../components/Choice';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { STATS_PATH } from '../lib/links';
import { useListeningStats } from '../lib/queries';
import { usePlayer } from '../player/store';
import { GRID } from './Albums';

const RANGES: { value: StatsRange; label: string }[] = [
  { value: 'month', label: '4 weeks' },
  { value: 'halfyear', label: '6 months' },
  { value: 'year', label: '12 months' },
  { value: 'all', label: 'All time' },
];

const HOURS = Array.from({ length: 24 }, (_, h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }));
// 2000-01-02 was a Sunday.
const WEEKDAYS = Array.from({ length: 7 }, (_, d) => new Date(2000, 0, 2 + d).toLocaleDateString(undefined, { weekday: 'short' }));
const MONTHS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString(undefined, { month: 'short' }));

const number = (n: number) => n.toLocaleString();
/** 95 → "1 h 35 min" */
export const minutesLabel = (m: number) => (m < 60 ? `${m} min` : `${number(Math.floor(m / 60))} h${m % 60 ? ` ${m % 60} min` : ''}`);
const isYear = (r: string) => /^\d{4}$/.test(r);

/** Your listening: what you played most, and when (Library → Your listening, or the account menu). */
export function StatsPage() {
  return (
    <div className="px-5 pt-8 pb-16 md:px-10 md:pt-14">
      <PageHeader title="Your listening" />
      <ListeningStatsView />
    </div>
  );
}

/** Your listening: what you played most, and when, for a period; each calendar year has a year in review. */
export function ListeningStatsView() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('range') ?? 'month';
  const range = (RANGES.some((r) => r.value === asked) || isYear(asked) ? asked : 'month') as StatsRange;
  const { data, error, isPending, refetch } = useListeningStats(range);
  const years = data?.years ?? [];
  const options = [...RANGES, ...years.map((y) => ({ value: String(y) as StatsRange, label: String(y) }))];

  return (
    <div>
      {isYear(range) && <h2 className="mb-6 font-display text-4xl text-paper md:text-5xl">Your {range}</h2>}
      <div className="mb-10">
        <Choice
          label="Period"
          options={options}
          value={range}
          onChange={(r) => setParams({ range: r }, { replace: true })}
          // On a phone the row scrolls from one edge of the screen to the other.
          className="-mx-5 px-5 md:-mx-1.5 md:px-1.5"
        />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <ReportSkeleton />
      ) : !data.plays ? (
        <EmptyState
          icon={ChartColumn}
          title="Nothing played in this period yet."
          hint="A song counts once it’s heard for 30 seconds, on every device that counts its plays."
          action="lucky"
        />
      ) : (
        <Report stats={data} />
      )}
    </div>
  );
}

function Report({ stats }: { stats: ListeningStats }) {
  const year = isYear(stats.range);
  const playTracks = usePlayer((s) => s.playTracks);
  const top = stats.topArtists[0];
  return (
    <div className="space-y-14">
      <section>
        {year && <div className="mb-2 type-kicker text-muted">Year in review</div>}
        {/* The big numbers are in the display face, without figures of one width: those set "1,792" as "1 , 792". */}
        <div className="font-display text-6xl leading-none text-paper md:text-7xl">
          {number(stats.minutes)}
          <span className="ml-3 font-sans text-xl text-paper-dim md:text-2xl">minutes</span>
        </div>
        <p className="mt-3 max-w-xl type-body text-paper-dim">
          {plural(stats.songs, 'song')} by {plural(stats.artists, 'artist')}, on {plural(stats.days, 'day')}.
        </p>
        <dl className="mt-8 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Tile label="Plays" value={number(stats.plays)} />
          <Tile label="Longest streak" value={plural(stats.longestStreak, 'day')} />
          <Tile label="New artists" value={number(stats.newArtists)} />
          <Tile label="A day, on average" value={minutesLabel(Math.round(stats.minutes / Math.max(1, stats.days)))} />
        </dl>
      </section>

      {year && top && (
        <section className="flex flex-col gap-6 sm:flex-row sm:items-end">
          <Link to={`/artists/${top.artist.id}`} className="block w-48 shrink-0 md:w-60">
            <ArtistAvatar name={top.artist.name} src={top.artist.imageUrl} size={240} />
          </Link>
          <div>
            <div className="type-kicker text-muted">Your artist of the year</div>
            <Link to={`/artists/${top.artist.id}`} className="mt-2 block font-display text-4xl text-paper hover:underline md:text-6xl">
              {top.artist.name}
            </Link>
            <p className="mt-2 type-body text-paper-dim">
              {minutesLabel(top.minutes)} over {plural(top.plays, 'play')}
              {stats.firstSong && (
                <>
                  {' '}
                  · your year started with{' '}
                  <Link to={`/albums/${stats.firstSong.track.albumId}`} className="text-paper hover:underline">
                    {stats.firstSong.track.title}
                  </Link>
                </>
              )}
            </p>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-5 type-section-title text-paper">Top artists</h2>
        <ol className="grid gap-x-8 gap-y-1 md:grid-cols-2">
          {stats.topArtists.map(({ artist, plays, minutes }, i) => (
            <li key={artist.id}>
              <Link to={`/artists/${artist.id}`} className="flex items-center gap-4 rounded-md px-2 py-2 transition hover:bg-paper/[0.05]">
                <span className="w-6 text-right font-mono text-sm text-muted tabular">{i + 1}</span>
                <ArtistAvatar name={artist.name} src={artist.imageUrl} size={48} className="size-12 shrink-0" />
                <NameAndNumbers
                  end
                  className="flex-1"
                  name={artist.name}
                  nameClassName="type-body text-paper"
                  numbers={`${minutesLabel(minutes)} · ${plural(plays, 'play')}`}
                  numbersClassName="type-small text-muted tabular"
                />
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <h2 className="type-section-title text-paper">Top songs</h2>
          <Button
            variant="primary"
            icon={<Play className="fill-current" />}
            onClick={() =>
              playTracks(
                stats.topTracks.map((t) => t.track),
                0,
                { shuffle: false, source: { label: year ? `Your top songs of ${stats.range}` : 'Your top songs', href: `${STATS_PATH}?range=${stats.range}` } },
              )
            }
          >
            Play them
          </Button>
        </div>
        {/* Two columns only where a song row fits whole in each: narrower, the titles would lose to the numbers. Columns
            of minmax(0, 1fr), so a long title is cut short rather than widening the list past the screen. */}
        <ol className="-mx-3 grid grid-cols-1 gap-x-8 page-xl:grid-cols-2">
          {stats.topTracks.map(({ track, plays }, i) => (
            <SongRow
              key={track.id}
              track={track}
              rank={i + 1}
              subtitle={<InlineLink to={`/artists/${track.artistId}`}>{track.artistName}</InlineLink>}
              numbers={plural(plays, 'play')}
              stackOnPhones
              onPlay={() =>
                playTracks(
                  stats.topTracks.map((t) => t.track),
                  i,
                  { shuffle: false, source: { label: 'Your top songs', href: `${STATS_PATH}?range=${stats.range}` } },
                )
              }
            />
          ))}
        </ol>
      </section>

      {stats.topAlbums.length > 0 && (
        <section>
          <h2 className="mb-5 type-section-title text-paper">Top albums</h2>
          <div className={GRID}>
            {stats.topAlbums.slice(0, 6).map(({ album }) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-6 type-section-title text-paper">When you listen</h2>
        <div className={cn('grid gap-10', year ? 'page-lg:grid-cols-[2fr_1fr]' : 'md:grid-cols-[2fr_1fr]')}>
          <ColumnChart title="By hour of the day" values={stats.hours} labels={HOURS} ticks={(i) => i % 6 === 0} format={minutesLabel} />
          <ColumnChart title="By day of the week" values={stats.weekdays} labels={WEEKDAYS} format={minutesLabel} />
        </div>
        {stats.months && (
          <ColumnChart className="mt-10" title="By month" values={stats.months} labels={MONTHS} format={minutesLabel} />
        )}
      </section>

      {stats.topGenres.length > 0 && (
        <section>
          <h2 className="mb-5 type-section-title text-paper">Your sound</h2>
          <ul className="flex flex-wrap gap-2">
            {stats.topGenres.map((g) => (
              <li key={g.genre} className="rounded-full border border-line px-4 py-2 text-sm text-paper">
                {g.genre} <span className="ml-1 type-meta text-muted">{minutesLabel(g.minutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The report's first screen while it loads: the minutes, the line under them, the four tiles, then the top artists. */
function ReportSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your listening" className="space-y-14">
      <section>
        <Skeleton className="h-[60px] w-64 max-w-full md:h-[72px]" />
        <Skeleton className="mt-4 h-4 w-80 max-w-full" />
        <div className="mt-8 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="mt-2 h-[30px] w-20" />
            </div>
          ))}
        </div>
      </section>
      <section>
        <Skeleton className="mb-5 h-7 w-40" />
        <div className="grid gap-x-8 gap-y-1 md:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-2 py-2">
              <Skeleton className="h-3 w-6" />
              <Skeleton className="size-12 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="type-small text-muted">{label}</dt>
      <dd className="mt-1.5 font-display text-3xl leading-none text-paper">{value}</dd>
    </div>
  );
}
