import type { Track } from '@playarr/shared';
import { ListMusic, ListPlus } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../components/Button';
import { Cover } from '../components/Cover';
import { Equalizer } from '../components/Equalizer';
import { FavoriteButton } from '../components/FavoriteButton';
import { FormatBadge } from '../components/FormatBadge';
import { InlineLink } from '../components/InlineLink';
import { upNextMenu } from '../components/menus';
import { OfflineMark } from '../components/OfflineMark';
import { PageHeader } from '../components/PageHeader';
import { SongRow, SongTime } from '../components/SongRow';
import { EmptyState } from '../components/States';
import { TransitionView } from '../components/TransitionView';
import { formatDuration, plural } from '../lib/format';
import { useTempos } from '../lib/queries';
import { toastWithUndo } from '../lib/toast';
import { useUI } from '../lib/ui';
import { moveUpcoming, playUpcoming } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';

export function QueuePage() {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  // What plays next, as positions in the player's queue (unique even when a song is queued twice).
  const upcomingIds = usePlayer(useShallow((s) => s.order.slice(s.pos + 1)));
  const queue = usePlayer((s) => s.queue);
  const source = usePlayer((s) => s.source);
  const upcoming = upcomingIds.map((i) => queue[i]!);
  const total = upcoming.reduce((sum, t) => sum + t.duration, 0);
  const openPicker = useUI((s) => s.openPlaylistPicker);

  if (!track) {
    return (
      <div className="px-5 pt-8 md:px-10 md:pt-14">
        <PageHeader title="Queue" />
        <EmptyState icon={ListMusic} title="Nothing queued yet." action="lucky" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Queue"
        actions={
          <Button icon={<ListPlus />} onClick={() => openPicker([track, ...upcoming])}>
            Save as playlist
          </Button>
        }
      />

      <section className="mb-12">
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
        <div className="flex items-center gap-4 rounded-panel border border-line bg-paper/[0.03] p-3 pr-4">
          <Cover src={track.coverUrl} size={72} alt="" className="size-[72px] shrink-0 rounded-cover" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <Equalizer playing={playing} />
              <span className="truncate type-body text-accent">{track.title}</span>
              <OfflineMark fileId={track.fileId} />
            </div>
            <div className="truncate type-small text-muted">
              <Link to={`/artists/${track.artistId}`} className="hover:text-paper hover:underline">{track.artistName}</Link>
              {' · '}
              <Link to={`/albums/${track.albumId}`} className="hover:text-paper hover:underline">{track.albumTitle}</Link>
            </div>
          </div>
          <FormatBadge format={track.format} className="hidden sm:inline-flex" />
          <SongTime seconds={track.duration} />
          <FavoriteButton track={track} size="md" />
        </div>
        <TransitionView className="mt-2 ml-1" />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
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
          <p className="py-6 text-sm text-muted">The queue ends after this song.</p>
        ) : (
          <UpNext ids={upcomingIds} queue={queue} />
        )}
      </section>
    </div>
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
function UpNext({ ids, queue }: { ids: number[]; queue: Track[] }) {
  // Dragging reorders this copy; the player's order changes when the drag ends.
  const [order, setOrder] = useState(ids);
  useEffect(() => setOrder(ids), [ids]);
  const commit = () => usePlayer.getState().setUpcoming(order);
  const tempos = useTempos(order.map((i) => queue[i]));
  return (
    <Reorder.Group axis="y" values={order} onReorder={setOrder} as="ol" className="-mx-3">
      {order.map((queueIndex, i) => (
        <UpNextRow
          key={queueIndex}
          queueIndex={queueIndex}
          track={queue[queueIndex]!}
          bpm={tempos[queue[queueIndex]!.recordingId]}
          position={i}
          count={order.length}
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
  onDragEnd,
}: {
  queueIndex: number;
  track: Track;
  /** Its measured tempo, if any. */
  bpm: number | undefined;
  /** Its place in Up next: 0 plays next. */
  position: number;
  count: number;
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
