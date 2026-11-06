import type { ListeningStats, StatsRange } from '@playarr/shared';
import { Play } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { AlbumCard } from '../components/Cards';
import { ColumnChart } from '../components/ColumnChart';
import { Cover } from '../components/Cover';
import { ErrorState, Skeleton } from '../components/Section';
import { PillGroup } from '../components/SettingsControls';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
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

/** Where Your listening lives: Settings → Your listening. */
export const STATS_PATH = '/settings/listening';

/** Your listening as its own page (older links to /stats). */
export function StatsPage() {
  return (
    <div className="px-5 pt-8 pb-16 md:px-10 md:pt-14">
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
        <PillGroup label="Period" options={options} value={range} onChange={(r) => setParams({ range: r }, { replace: true })} />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className="space-y-6">
          <Skeleton className="h-24 max-w-md" />
          <Skeleton className="h-64" />
        </div>
      ) : !data.plays ? (
        <p className="max-w-md text-[15px] text-paper-dim">
          Nothing played in this period yet. Songs count once heard for 30 seconds, from every device that counts its plays (Settings → Playback).
        </p>
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
        {year && <div className="mb-2 font-mono text-[11px] tracking-[0.2em] text-accent uppercase">Year in review</div>}
        <div className="font-sans text-[3.5rem] leading-none font-semibold tracking-tight text-paper tabular md:text-[5rem]">
          {number(stats.minutes)}
          <span className="ml-3 text-[1.25rem] font-normal tracking-normal text-paper-dim md:text-2xl">minutes</span>
        </div>
        <p className="mt-3 max-w-xl text-[15px] text-paper-dim">
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
            <Cover src={top.artist.imageUrl} size={260} alt={top.artist.name} className="aspect-square rounded-cover ring-1 ring-paper/10" />
          </Link>
          <div>
            <div className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Your artist of the year</div>
            <Link to={`/artists/${top.artist.id}`} className="mt-2 block font-display text-4xl text-paper hover:underline md:text-6xl">
              {top.artist.name}
            </Link>
            <p className="mt-2 text-[15px] text-paper-dim">
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
        <h2 className="mb-5 font-display text-3xl text-paper">Top artists</h2>
        <ol className="grid gap-x-8 gap-y-1 md:grid-cols-2">
          {stats.topArtists.map(({ artist, plays, minutes }, i) => (
            <li key={artist.id}>
              <Link to={`/artists/${artist.id}`} className="flex items-center gap-4 rounded-md px-2 py-2 transition hover:bg-paper/[0.05]">
                <span className="w-6 text-right font-mono text-sm text-muted tabular">{i + 1}</span>
                <Cover src={artist.imageUrl} size={56} alt="" className="size-12 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 truncate text-[15px] text-paper">{artist.name}</span>
                <span className="shrink-0 text-right text-[13px] text-muted tabular">
                  {minutesLabel(minutes)} · {plural(plays, 'play')}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-display text-3xl text-paper">Top songs</h2>
          <button
            type="button"
            onClick={() =>
              playTracks(
                stats.topTracks.map((t) => t.track),
                0,
                { shuffle: false, source: { label: year ? `Your top songs of ${stats.range}` : 'Your top songs', href: `${STATS_PATH}?range=${stats.range}` } },
              )
            }
            className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition hover:brightness-110"
          >
            <Play className="size-4 fill-current" /> Play them
          </button>
        </div>
        <ol className="grid gap-x-8 gap-y-1 md:grid-cols-2">
          {stats.topTracks.map(({ track, plays }, i) => (
            <li key={track.id}>
              <button
                type="button"
                onClick={() =>
                  playTracks(
                    stats.topTracks.map((t) => t.track),
                    i,
                    { shuffle: false, source: { label: 'Your top songs', href: `${STATS_PATH}?range=${stats.range}` } },
                  )
                }
                className="flex w-full items-center gap-4 rounded-md px-2 py-2 text-left transition hover:bg-paper/[0.05]"
              >
                <span className="w-6 text-right font-mono text-sm text-muted tabular">{i + 1}</span>
                <Cover src={track.coverUrl} size={48} alt="" className="size-11 shrink-0 rounded-cover" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-paper">{track.title}</span>
                  <span className="block truncate text-[13px] text-muted">{track.artistName}</span>
                </span>
                <span className="shrink-0 text-[13px] text-muted tabular">{plural(plays, 'play')}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {stats.topAlbums.length > 0 && (
        <section>
          <h2 className="mb-5 font-display text-3xl text-paper">Top albums</h2>
          <div className={GRID}>
            {stats.topAlbums.slice(0, 6).map(({ album }) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-6 font-display text-3xl text-paper">When you listen</h2>
        <div className={cn('grid gap-10', year ? 'lg:grid-cols-[2fr_1fr]' : 'md:grid-cols-[2fr_1fr]')}>
          <ColumnChart title="By hour of the day" values={stats.hours} labels={HOURS} ticks={(i) => i % 6 === 0} format={minutesLabel} />
          <ColumnChart title="By day of the week" values={stats.weekdays} labels={WEEKDAYS} format={minutesLabel} />
        </div>
        {stats.months && (
          <ColumnChart className="mt-10" title="By month" values={stats.months} labels={MONTHS} format={minutesLabel} />
        )}
      </section>

      {stats.topGenres.length > 0 && (
        <section>
          <h2 className="mb-5 font-display text-3xl text-paper">Your sound</h2>
          <ul className="flex flex-wrap gap-2">
            {stats.topGenres.map((g) => (
              <li key={g.genre} className="rounded-full border border-line px-4 py-2 text-[14px] text-paper">
                {g.genre} <span className="ml-1 text-[12px] text-muted tabular">{minutesLabel(g.minutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-paper tabular">{value}</dd>
    </div>
  );
}
