import { X } from 'lucide-react';
import { Link } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { Cover } from '../components/Cover';
import { Equalizer } from '../components/Equalizer';
import { FavoriteButton } from '../components/FavoriteButton';
import { FormatBadge } from '../components/FormatBadge';
import { cn } from '../lib/cn';
import { formatDuration, formatTime, plural } from '../lib/format';
import { useCurrentTrack, usePlayer } from '../player/store';
import { PageTitle } from './Albums';

export function QueuePage() {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const pos = usePlayer((s) => s.pos);
  const upcoming = usePlayer(useShallow((s) => s.order.slice(s.pos + 1).map((i) => s.queue[i]!)));
  const { jumpTo, removeAt, clearUpcoming } = usePlayer.getState();
  const total = upcoming.reduce((sum, t) => sum + t.duration, 0);

  if (!track) {
    return (
      <div className="px-5 pt-8 md:px-10 md:pt-14">
        <PageTitle title="Queue" />
        <p className="text-muted">
          Nothing queued. Pick an <Link to="/albums" className="text-accent hover:underline">album</Link> to start listening.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Queue" />

      <section className="mb-12">
        <div className="mb-3 font-mono text-[11px] tracking-[0.25em] text-muted uppercase">Now playing</div>
        <div className="flex items-center gap-4 rounded-lg border border-line bg-paper/[0.03] p-3 pr-5">
          <Cover src={track.coverUrl} size={72} alt="" className="size-[72px] shrink-0 rounded-[4px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <Equalizer playing={playing} />
              <span className="truncate text-lg text-accent">{track.title}</span>
            </div>
            <div className="truncate text-sm text-muted">
              <Link to={`/artists/${track.artistId}`} className="hover:text-paper hover:underline">{track.artistName}</Link>
              {' · '}
              <Link to={`/albums/${track.albumId}`} className="hover:text-paper hover:underline">{track.albumTitle}</Link>
            </div>
          </div>
          <FormatBadge format={track.format} className="hidden sm:inline-flex" />
          <FavoriteButton track={track} size="md" />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="font-mono text-[11px] tracking-[0.25em] text-muted uppercase">
            Up next{upcoming.length > 0 && ` · ${plural(upcoming.length, 'track')} · ${formatDuration(total)}`}
          </div>
          {upcoming.length > 0 && (
            <button type="button" onClick={clearUpcoming} className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase hover:text-paper">
              Clear
            </button>
          )}
        </div>
        {upcoming.length === 0 ? (
          <p className="py-6 text-sm text-muted">The queue ends after this track.</p>
        ) : (
          <ol className="-mx-3">
            {upcoming.map((t, i) => (
              <li
                key={`${t.id}-${pos + 1 + i}`}
                className="group grid cursor-pointer grid-cols-[2.75rem_1fr_auto_auto_auto] items-center gap-3 rounded-md px-3 py-2 transition hover:bg-paper/[0.045] md:gap-4"
                onClick={() => jumpTo(pos + 1 + i)}
              >
                <Cover src={t.coverUrl} size={44} alt="" className="size-11 rounded-[3px]" />
                <div className="min-w-0">
                  <div className="truncate text-[15px] text-paper">{t.title}</div>
                  <div className="truncate text-[13px] text-muted">{t.artistName}</div>
                </div>
                <FavoriteButton track={t} reveal />
                <span className="font-mono text-[13px] text-muted tabular">{formatTime(t.duration)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${t.title} from queue`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAt(pos + 1 + i);
                  }}
                  className={cn('grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper md:opacity-0 md:group-hover:opacity-100')}
                >
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
