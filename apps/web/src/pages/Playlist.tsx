import type { CoverLayout, PlaylistCoverInfo, PlaylistItem } from '@playarr/shared';
import { Disc3, GripVertical, ListEnd, ListPlus, Mic2, Pencil, Play, Shuffle, Trash2, X } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Cover } from '../components/Cover';
import { Dialog } from '../components/Dialog';
import { Equalizer } from '../components/Equalizer';
import { FavoriteButton } from '../components/FavoriteButton';
import { Menu } from '../components/Menu';
import { PlaylistCover } from '../components/PlaylistCover';
import { PlaylistRecommendations } from '../components/PlaylistRecommendations';
import { ErrorState, Skeleton } from '../components/Section';
import { cn } from '../lib/cn';
import { formatDuration, formatTime, plural } from '../lib/format';
import { usePlaylist, usePlaylistMutations } from '../lib/queries';
import { queueTracks } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';

export function PlaylistPage() {
  const id = Number(useParams().id);
  const { data: playlist, error, isPending } = usePlaylist(id);
  const mutations = usePlaylistMutations();
  const playTracks = usePlayer((s) => s.playTracks);
  const navigate = useNavigate();
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);

  // Local copy so drag-reordering is instant; resync whenever the server copy changes.
  useEffect(() => {
    if (playlist) setItems(playlist.items);
  }, [playlist]);

  if (error) return <ErrorState error={error} />;
  if (isPending || !playlist) {
    return (
      <div className="px-5 pt-8 md:px-10 md:pt-14">
        <div className="flex flex-col gap-6 md:flex-row md:items-end">
          <Skeleton className="aspect-square w-56" />
          <Skeleton className="h-14 w-72" />
        </div>
      </div>
    );
  }

  const playable = items.flatMap((i) => (i.track ? [i.track] : []));
  const playFrom = (item: PlaylistItem) => {
    const index = playable.findIndex((t) => t === item.track);
    if (index >= 0) playTracks(playable, index, { shuffle: false });
  };
  const commitOrder = () => {
    const ids = items.map((i) => i.itemId);
    if (ids.join() !== playlist.items.map((i) => i.itemId).join()) mutations.reorder.mutate({ id, itemIds: ids });
  };
  const unavailable = items.length - playable.length;

  return (
    <div className="px-5 pt-6 md:px-10 md:pt-14">
      <header className="flex flex-col gap-6 md:flex-row md:items-end md:gap-10">
        <PlaylistCover
          cover={playlist.cover}
          size={256}
          name={playlist.name}
          className="mx-auto w-[min(64vw,256px)] shrink-0 animate-rise rounded-[4px] shadow-[0_30px_70px_-20px_rgb(0_0_0/0.9)] ring-1 ring-paper/10 md:mx-0 md:w-56 lg:w-64"
        />
        <div className="min-w-0 flex-1 animate-rise [animation-delay:80ms]">
          <div className="font-mono text-[11px] tracking-[0.25em] text-paper-dim/70 uppercase">Playlist</div>
          {editing ? (
            <EditDetails
              name={playlist.name}
              description={playlist.description}
              onCancel={() => setEditing(false)}
              onSave={(patch) => mutations.update.mutate({ id, ...patch }, { onSuccess: () => setEditing(false) })}
            />
          ) : (
            <>
              <h1
                className="mt-2 cursor-text font-display text-[2.5rem] leading-[1.02] tracking-tight text-balance text-paper md:text-6xl lg:text-7xl"
                onClick={() => setEditing(true)}
                title="Click to rename"
              >
                {playlist.name}
              </h1>
              {playlist.description ? (
                <p className="mt-3 max-w-2xl text-[15px] text-paper-dim/90" onClick={() => setEditing(true)}>
                  {playlist.description}
                </p>
              ) : null}
            </>
          )}
          <div className="mt-4 font-mono text-[12px] text-muted">
            {plural(items.length, 'song')} · {formatDuration(playlist.duration)}
            {unavailable > 0 && ` · ${unavailable} not in library`}
          </div>
          {items.length > 0 && <CoverNote cover={playlist.cover} />}
        </div>
      </header>

      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          disabled={!playable.length}
          onClick={() => playTracks(playable, 0, { shuffle: false })}
          aria-label={`Play ${playlist.name}`}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-medium text-accent-ink shadow-[0_10px_40px_-12px_var(--accent)] transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
        >
          <Play className="size-5 fill-current" /> Play
        </button>
        <button
          type="button"
          disabled={!playable.length}
          onClick={() => playTracks(playable, 0, { shuffle: true })}
          aria-label={`Shuffle ${playlist.name}`}
          className="inline-flex h-12 items-center gap-2 rounded-full border border-paper/15 px-5 text-paper transition hover:border-paper/35 hover:bg-paper/5 disabled:opacity-40"
        >
          <Shuffle className="size-[18px]" /> Shuffle
        </button>
        <Menu
          className="size-12 border border-paper/15 text-paper"
          label="Playlist actions"
          items={[
            { label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) },
            ...(playable.length
              ? [
                  { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(playable, 'next') },
                  { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(playable, 'end') },
                ]
              : []),
            { label: 'Delete playlist', icon: Trash2, onSelect: () => setConfirmDelete(true) },
          ]}
        />
      </div>

      {items.length === 0 ? (
        <p className="mt-12 max-w-md text-sm text-muted">
          This playlist is empty. Use <span className="text-paper-dim">Add to playlist…</span> from any song’s ⋯ menu, an
          album, the queue or Now Playing.
        </p>
      ) : (
        <Reorder.Group axis="y" values={items} onReorder={setItems} as="ol" className="mt-8 -mx-3 max-w-5xl">
          {items.map((item) => (
            <PlaylistRow
              key={item.itemId}
              item={item}
              onPlay={() => playFrom(item)}
              onDragEnd={commitOrder}
              onRemove={() => mutations.remove.mutate({ id, itemId: item.itemId })}
            />
          ))}
        </Reorder.Group>
      )}

      <PlaylistRecommendations playlistId={id} enabled={items.length > 0} />

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete playlist?">
        <div className="p-5">
          <p className="text-sm text-paper-dim">
            “{playlist.name}” will be deleted. The songs stay in your library. This can’t be undone.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="h-10 rounded-lg border border-line px-4 text-paper transition hover:bg-paper/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                mutations.destroy.mutate(id, {
                  onSuccess: () => navigate('/playlists', { replace: true }),
                })
              }
              className="h-10 rounded-lg bg-red-500/90 px-4 font-medium text-white transition hover:bg-red-500"
            >
              Delete
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function PlaylistRow({
  item,
  onPlay,
  onDragEnd,
  onRemove,
}: {
  item: PlaylistItem;
  onPlay: () => void;
  onDragEnd: () => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  const current = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const navigate = useNavigate();
  const { track } = item;
  const isCurrent = !!track && current?.fileId === track.fileId;

  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      whileDrag={{ scale: 1.02, boxShadow: '0 16px 40px -12px rgb(0 0 0 / 0.8)' }}
      className={cn(
        'group relative grid grid-cols-[1.5rem_2.75rem_1fr_auto_auto_auto] items-center gap-2 rounded-md bg-ink-900 px-2 py-2 transition-colors hover:bg-ink-850 md:gap-3',
        track ? 'cursor-pointer' : 'opacity-50',
        isCurrent && 'bg-ink-850',
      )}
      onClick={() => track && onPlay()}
    >
      <span
        role="button"
        aria-label={`Drag to reorder ${item.title}`}
        onPointerDown={(e) => controls.start(e)}
        onClick={(e) => e.stopPropagation()}
        className="grid h-9 cursor-grab touch-none place-items-center text-muted active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100"
      >
        <GripVertical className="size-4" />
      </span>
      <div className="relative">
        <Cover src={track?.coverUrl} size={44} alt="" label={item.albumTitle} className="size-11 rounded-[3px]" />
        {isCurrent && (
          <div className="absolute inset-0 grid place-items-center rounded-[3px] bg-black/50">
            <Equalizer playing={playing} />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className={cn('truncate text-[15px]', isCurrent ? 'text-accent' : 'text-paper')}>{item.title}</div>
        <div className="truncate text-[13px] text-muted">
          {item.artistName} <span className="text-ink-600">·</span> {item.albumTitle}
          {!track && <span className="ml-2 font-mono text-[10px] tracking-wider uppercase">not in library</span>}
        </div>
      </div>
      {track ? <FavoriteButton track={track} reveal /> : <span />}
      <span className="font-mono text-[13px] text-muted tabular">{track ? formatTime(track.duration) : ''}</span>
      <div onClick={(e) => e.stopPropagation()} className="md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        <Menu
          items={[
            ...(track
              ? [
                  { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks([track], 'next') },
                  { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks([track], 'end') },
                  { label: 'Go to album', icon: Disc3, onSelect: () => navigate(`/albums/${track.albumId}`) },
                  { label: 'Go to artist', icon: Mic2, onSelect: () => navigate(`/artists/${track.artistId}`) },
                ]
              : []),
            { label: 'Remove from playlist', icon: X, onSelect: onRemove },
          ]}
        />
      </div>
    </Reorder.Item>
  );
}

const COVER_STORY: Record<CoverLayout, string> = {
  ridges: 'Each line is a song, traced from its loudness over time.',
  grooves: 'A record of the playlist: each band of grooves is a song, as wide as it is long.',
  blocks: 'A tile per song, sized by its length; each shape follows how it sounds.',
  horizon: 'Each hill is a song’s loudness over time. The slower the music, the bigger the sun.',
  currents: 'Each ribbon belongs to a song: a steady beat flows smoothly, free time swirls; louder songs run wider.',
  colonies: 'Each style is a slime-mould species in its own colour, growing with its songs’ tempo and beat.',
};

/** What the generated cover is made of, so it reads as a portrait of the music rather than decoration. */
function CoverNote({ cover }: { cover: PlaylistCoverInfo }) {
  const facts = [
    cover.tempo && `${cover.tempo} BPM`,
    cover.styles.length && cover.styles.join(' / '),
    cover.era && (cover.era[0] === cover.era[1] ? String(cover.era[0]) : `${cover.era[0]}–${cover.era[1]}`),
    `energy ${Math.round(cover.energy * 100)}%`,
  ].filter(Boolean);
  return (
    <div className="mt-3 max-w-xl text-[13px] leading-snug text-muted">
      {cover.pending ? (
        <span className="inline-flex items-center gap-2">
          <span className="size-1.5 animate-pulse rounded-full bg-accent" />
          Listening to the songs to draw the cover… {cover.analyzed} of {cover.total}
        </span>
      ) : (
        <>
          <span className="text-paper-dim/80">{COVER_STORY[cover.layout]}</span>
          <span className="mt-1 block font-mono text-[11px] tracking-wide uppercase">{facts.join(' · ')}</span>
        </>
      )}
    </div>
  );
}

function EditDetails({
  name: initialName,
  description: initialDescription,
  onSave,
  onCancel,
}: {
  name: string;
  description: string;
  onSave: (patch: { name: string; description: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const save = () => (name.trim() ? onSave({ name, description }) : onCancel());
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) save();
  };
  return (
    <div className="mt-2 max-w-2xl space-y-3" onKeyDown={onKey}>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        aria-label="Playlist name"
        className="w-full border-b border-accent bg-transparent font-display text-4xl leading-tight text-paper focus:outline-none md:text-5xl"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={300}
        rows={2}
        placeholder="Add a description"
        aria-label="Description"
        className="w-full resize-none rounded-md border border-line bg-ink-900/60 p-2 text-[15px] text-paper-dim placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <div className="flex gap-2">
        <button type="button" onClick={save} className="h-9 rounded-full bg-accent px-4 text-sm font-medium text-accent-ink">
          Save
        </button>
        <button type="button" onClick={onCancel} className="h-9 rounded-full border border-line px-4 text-sm text-paper">
          Cancel
        </button>
      </div>
    </div>
  );
}
