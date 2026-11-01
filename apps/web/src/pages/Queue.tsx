import type { Track } from '@playarr/shared';
import { Disc3, GripVertical, ListMusic, ListPlus, ListStart, Mic2, X } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { Cover } from '../components/Cover';
import { Equalizer } from '../components/Equalizer';
import { FavoriteButton } from '../components/FavoriteButton';
import { FormatBadge } from '../components/FormatBadge';
import { Menu } from '../components/Menu';
import { OfflineMark } from '../components/OfflineMark';
import { TransitionView } from '../components/TransitionView';
import { formatDuration, formatTime, plural } from '../lib/format';
import { toast } from '../lib/toast';
import { useUI } from '../lib/ui';
import { useCurrentTrack, usePlayer } from '../player/store';
import { PageTitle } from './Albums';

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
        <PageTitle title="Queue" />
        <p className="text-muted">
          Nothing queued. Pick an <Link to="/albums" className="text-accent hover:underline">album</Link> to start listening.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Queue">
        <button
          type="button"
          onClick={() => openPicker([track, ...upcoming])}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 font-mono text-[11px] tracking-wider text-paper-dim uppercase transition hover:border-paper/30 hover:text-paper"
        >
          <ListPlus className="size-4" /> Save as playlist
        </button>
      </PageTitle>

      <section className="mb-12">
        <div className="mb-3 font-mono text-[11px] tracking-[0.25em] text-muted uppercase">
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
        <div className="flex items-center gap-4 rounded-lg border border-line bg-paper/[0.03] p-3 pr-5">
          <Cover src={track.coverUrl} size={72} alt="" className="size-[72px] shrink-0 rounded-[4px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <Equalizer playing={playing} />
              <span className="truncate text-lg text-accent">{track.title}</span>
              <OfflineMark fileId={track.fileId} />
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
        <TransitionView className="mt-2 ml-1" />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="font-mono text-[11px] tracking-[0.25em] text-muted uppercase">
            Up next{upcoming.length > 0 && ` · ${plural(upcoming.length, 'track')} · ${formatDuration(total)}`}
          </div>
          {upcoming.length > 0 && (
            <button type="button" onClick={() => clearWithUndo(upcomingIds)} className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase hover:text-paper">
              Clear
            </button>
          )}
        </div>
        {upcoming.length === 0 ? (
          <p className="py-6 text-sm text-muted">The queue ends after this track.</p>
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
  toast(`Cleared ${plural(ids.length, 'track')}`, 'info', {
    label: 'Undo',
    run: () => {
      const s = usePlayer.getState();
      if (s.order[s.pos] === current) setUpcoming([...ids, ...s.order.slice(s.pos + 1)]);
    },
  });
}

/** Up next: drag to reorder (by the grip), tap to play from there, ⋯ for the rest. */
function UpNext({ ids, queue }: { ids: number[]; queue: Track[] }) {
  // Dragging reorders this copy; the player's order changes when the drag ends.
  const [order, setOrder] = useState(ids);
  useEffect(() => setOrder(ids), [ids]);
  const commit = () => usePlayer.getState().setUpcoming(order);
  return (
    <Reorder.Group axis="y" values={order} onReorder={setOrder} as="ol" className="-mx-3">
      {order.map((queueIndex, i) => (
        <UpNextRow key={queueIndex} queueIndex={queueIndex} track={queue[queueIndex]!} position={i} order={order} onDragEnd={commit} />
      ))}
    </Reorder.Group>
  );
}

function UpNextRow({
  queueIndex,
  track: t,
  position,
  order,
  onDragEnd,
}: {
  queueIndex: number;
  track: Track;
  position: number;
  order: number[];
  onDragEnd: () => void;
}) {
  const controls = useDragControls();
  const navigate = useNavigate();
  const openPicker = useUI((s) => s.openPlaylistPicker);
  const p = () => usePlayer.getState();
  const at = () => p().pos + 1 + position;
  return (
    <Reorder.Item
      value={queueIndex}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      whileDrag={{ scale: 1.02, boxShadow: '0 16px 40px -12px rgb(0 0 0 / 0.8)' }}
      className="group grid cursor-pointer grid-cols-[1.5rem_2.75rem_1fr_auto_auto_auto] items-center gap-2 rounded-md bg-ink-900 px-2 py-2 transition-colors hover:bg-ink-850 md:gap-3"
      onClick={() => p().jumpTo(at())}
    >
      <span
        role="button"
        aria-label={`Drag to reorder ${t.title}`}
        onPointerDown={(e) => controls.start(e)}
        onClick={(e) => e.stopPropagation()}
        className="grid h-9 cursor-grab touch-none place-items-center text-muted active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100"
      >
        <GripVertical className="size-4" />
      </span>
      <Cover src={t.coverUrl} size={44} alt="" className="size-11 rounded-[3px]" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] text-paper">{t.title}</span>
          <OfflineMark fileId={t.fileId} />
        </div>
        <div className="truncate text-[13px] text-muted">{t.artistName}</div>
      </div>
      <FavoriteButton track={t} reveal />
      <span className="font-mono text-[13px] text-muted tabular max-sm:hidden">{formatTime(t.duration)}</span>
      <div onClick={(e) => e.stopPropagation()} className="md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        <Menu
          label={`Actions for ${t.title}`}
          items={[
            ...(position > 0
              ? [{ label: 'Play next', icon: ListStart, onSelect: () => p().setUpcoming([queueIndex, ...order.filter((i) => i !== queueIndex)]) }]
              : []),
            { label: 'Add to playlist…', icon: ListMusic, onSelect: () => openPicker([t]) },
            { label: 'Go to album', icon: Disc3, onSelect: () => navigate(`/albums/${t.albumId}`) },
            { label: 'Go to artist', icon: Mic2, onSelect: () => navigate(`/artists/${t.artistId}`) },
            { label: 'Remove from queue', icon: X, onSelect: () => p().removeAt(at()) },
          ]}
        />
      </div>
    </Reorder.Item>
  );
}
