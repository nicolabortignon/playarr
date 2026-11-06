import type { Track } from '@playarr/shared';
import { ListMusic, ListPlus } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../lib/cn';
import { formatDuration, plural } from '../lib/format';
import { useTempos } from '../lib/queries';
import { toastWithUndo } from '../lib/toast';
import { useUI } from '../lib/ui';
import { moveUpcoming, playUpcoming } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';
import { Button } from './Button';
import { Cover } from './Cover';
import { Equalizer } from './Equalizer';
import { FavoriteButton } from './FavoriteButton';
import { FormatBadge } from './FormatBadge';
import { InlineLink } from './InlineLink';
import { upNextMenu } from './menus';
import { OfflineMark } from './OfflineMark';
import { SongRow, SongTime } from './SongRow';
import { EmptyState } from './States';
import { TransitionView } from './TransitionView';

/** Saving the song playing and what follows it as a playlist: the Queue page's header, the column's foot. */
export function useSaveQueue(): (() => void) | undefined {
  const track = useCurrentTrack();
  const openPicker = useUI((s) => s.openPlaylistPicker);
  if (!track) return undefined;
  return () => {
    const s = usePlayer.getState();
    openPicker([track, ...s.order.slice(s.pos + 1).map((i) => s.queue[i]!)]);
  };
}

/**
 * The queue: the song playing, set apart, with where it's from, then Up next with Clear. The Queue page's, and
 * `narrow` in the column beside the page at desktop widths (components/SideColumn.tsx), as the iPad app's: a smaller
 * card, rows laid out as on a phone (the length under the title, no heart), Save as playlist at its foot.
 */
export function QueueView({ narrow }: { narrow?: boolean }) {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  // What plays next, as positions in the player's queue (unique even when a song is queued twice).
  const upcomingIds = usePlayer(useShallow((s) => s.order.slice(s.pos + 1)));
  const queue = usePlayer((s) => s.queue);
  const source = usePlayer((s) => s.source);
  const save = useSaveQueue();
  const upcoming = upcomingIds.map((i) => queue[i]!);
  const total = upcoming.reduce((sum, t) => sum + t.duration, 0);

  if (!track) return <EmptyState icon={ListMusic} title="Nothing queued yet." action="lucky" className={narrow ? 'py-10 md:py-10' : undefined} />;

  return (
    <>
      <section className={narrow ? 'mb-8' : 'mb-12'}>
        <div className="mb-3 type-kicker text-muted">
          Now playing
          {source && (
            <>
              {' · from '}
              <Link to={source.href} className="text-paper-dim hover:text-paper hover:underline">
                {source.label}
              </Link>
            </>
          )}
        </div>
        {/* The song playing, set apart: a row's type and trailing order (time · ♥), with a larger cover. */}
        <div className={cn('flex items-center rounded-panel border border-line bg-paper/[0.03]', narrow ? 'gap-3 p-2.5 pr-2' : 'gap-4 p-3 pr-4')}>
          <Cover
            src={track.coverUrl}
            size={narrow ? 56 : 72}
            alt=""
            className={cn('shrink-0 rounded-cover', narrow ? 'size-14' : 'size-[72px]')}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <Equalizer playing={playing} />
              <span className="truncate type-body text-accent">{track.title}</span>
              <OfflineMark fileId={track.fileId} />
            </div>
            <div className="truncate type-small text-muted">
              <Link to={`/artists/${track.artistId}`} className="hover:text-paper hover:underline">
                {track.artistName}
              </Link>
              {' · '}
              <Link to={`/albums/${track.albumId}`} className="hover:text-paper hover:underline">
                {track.albumTitle}
              </Link>
            </div>
          </div>
          {!narrow && <FormatBadge format={track.format} className="hidden sm:inline-flex" />}
          {!narrow && <SongTime seconds={track.duration} />}
          <FavoriteButton track={track} size="md" />
        </div>
        <TransitionView className="mt-2 ml-1" />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="type-kicker text-muted">
            Up next{upcoming.length > 0 && ` · ${plural(upcoming.length, 'song')} · ${formatDuration(total)}`}
          </div>
          {upcoming.length > 0 && (
            <Button variant="ghost" size="small" onClick={() => clearWithUndo(upcomingIds)}>
              Clear
            </Button>
          )}
        </div>
        {upcoming.length === 0 ? (
          <p className="py-6 type-small text-muted">The queue ends after this song.</p>
        ) : (
          <UpNext ids={upcomingIds} queue={queue} narrow={narrow} />
        )}
        {narrow && save && (
          <Button size="small" icon={<ListPlus />} onClick={save} className="mt-6">
            Save as playlist
          </Button>
        )}
      </section>
    </>
  );
}

/** Clear what's coming up, with a way back for a mis-tap. */
function clearWithUndo(ids: number[]) {
  const { clearUpcoming, setUpcoming } = usePlayer.getState();
  const current = usePlayer.getState().order[usePlayer.getState().pos];
  clearUpcoming();
  toastWithUndo(`Cleared ${plural(ids.length, 'song')} from the queue`, () => {
    const s = usePlayer.getState();
    if (s.order[s.pos] === current) setUpcoming([...ids, ...s.order.slice(s.pos + 1)]);
  });
}

/**
 * Up next: tap a song to play from there; drag it by its handle, or move it with the handle's arrow keys or its menu's
 * Move up and Move down; ⋯ (or a right-click, or a long press) for the rest.
 */
function UpNext({ ids, queue, narrow }: { ids: number[]; queue: Track[]; narrow?: boolean }) {
  // Dragging reorders this copy; the player's order changes when the drag ends.
  const [order, setOrder] = useState(ids);
  useEffect(() => setOrder(ids), [ids]);
  const commit = () => usePlayer.getState().setUpcoming(order);
  const tempos = useTempos(order.map((i) => queue[i]));
  return (
    <Reorder.Group axis="y" values={order} onReorder={setOrder} as="ol" className={narrow ? '-mx-2' : '-mx-3'}>
      {order.map((queueIndex, i) => (
        <UpNextRow
          key={queueIndex}
          queueIndex={queueIndex}
          track={queue[queueIndex]!}
          bpm={tempos[queue[queueIndex]!.recordingId]}
          position={i}
          count={order.length}
          narrow={narrow}
          onDragEnd={commit}
        />
      ))}
    </Reorder.Group>
  );
}

function UpNextRow({
  queueIndex,
  track: t,
  bpm,
  position,
  count,
  narrow,
  onDragEnd,
}: {
  queueIndex: number;
  track: Track;
  /** Its measured tempo, if any. */
  bpm: number | undefined;
  /** Its place in Up next: 0 plays next. */
  position: number;
  count: number;
  narrow?: boolean;
  onDragEnd: () => void;
}) {
  const controls = useDragControls();
  return (
    <SongRow
      track={t}
      markCurrent={false}
      // The artist alone: on a phone the length shares its line, and a name never loses to numbers.
      subtitle={<InlineLink to={`/artists/${t.artistId}`}>{t.artistName}</InlineLink>}
      stackOnPhones
      narrow={narrow}
      onPlay={() => playUpcoming(position)}
      bpm={bpm}
      menu={upNextMenu(position, count)}
      reorder={{
        value: queueIndex,
        controls,
        label: `Drag to reorder ${t.title}`,
        onDragEnd,
        onMove: (by) => moveUpcoming(position, position + by),
      }}
    />
  );
}
