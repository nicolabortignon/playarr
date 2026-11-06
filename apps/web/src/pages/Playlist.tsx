import type { PlaylistItem } from '@playarr/shared';
import { Disc3, GripVertical, Info, ListEnd, ListPlus, Lock, Mic2, Palette, Pencil, Trash2, Users, X } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ActionRow, usePlayState } from '../components/ActionRow';
import { Button } from '../components/Button';
import { Cover } from '../components/Cover';
import { DetailHeader, DetailHeaderSkeleton, joinMeta } from '../components/DetailHeader';
import { Dialog } from '../components/Dialog';
import { Equalizer } from '../components/Equalizer';
import { FavoriteButton } from '../components/FavoriteButton';
import { Menu } from '../components/Menu';
import { CoverPicker } from '../components/CoverPicker';
import { PlaylistCover } from '../components/PlaylistCover';
import { PlaylistRecommendations } from '../components/PlaylistRecommendations';
import { BackButton, ErrorState } from '../components/Section';
import { cn } from '../lib/cn';
import { formatDuration, formatTime, plural } from '../lib/format';
import { usePlaylist, usePlaylistMutations, useTempos } from '../lib/queries';
import { useUI } from '../lib/ui';
import { queueTracks } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';
import { Tempo } from '../components/Tempo';

export function PlaylistPage() {
  const id = Number(useParams().id);
  const { data: playlist, error, isPending, refetch } = usePlaylist(id);
  const mutations = usePlaylistMutations();
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const playState = usePlayState(`/playlists/${id}`);
  const navigate = useNavigate();
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pickingCover, setPickingCover] = useState(false);
  const tempos = useTempos(items.map((i) => i.track));

  // Local copy so drag-reordering is instant; resync whenever the server copy changes.
  useEffect(() => {
    if (playlist) setItems(playlist.items);
  }, [playlist]);

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !playlist) {
    return (
      <div className="px-5 pt-6 md:px-10 md:pt-14">
        <DetailHeaderSkeleton />
      </div>
    );
  }

  const playable = items.flatMap((i) => (i.track ? [i.track] : []));
  const playFrom = (item: PlaylistItem) => {
    const index = playable.findIndex((t) => t === item.track);
    if (index >= 0) playTracks(playable, index, { shuffle: false, source: { label: playlist.name, href: `/playlists/${id}` } });
  };
  const commitOrder = () => {
    const ids = items.map((i) => i.itemId);
    if (ids.join() !== playlist.items.map((i) => i.itemId).join()) mutations.reorder.mutate({ id, itemIds: ids });
  };
  const unavailable = items.length - playable.length;
  // Another account's shared playlist plays here; only its owner changes it.
  const mine = playlist.mine;
  const canPickCover = mine && items.length > 0;
  const cover = (
    <PlaylistCover
      cover={playlist.cover}
      size={288}
      name={playlist.name}
      titled={false}
      className="w-full rounded-cover shadow-cover-hero ring-1 ring-paper/10"
    />
  );

  return (
    <div className="relative px-5 pt-6 md:px-10 md:pt-14">
      <BackButton fallback="/playlists" className="absolute top-3 left-3 z-20" />
      <DetailHeader
        // The cover is also the way to a new one (and says so when the songs have moved on from it).
        cover={
          canPickCover ? (
            <button
              type="button"
              onClick={() => setPickingCover(true)}
              aria-label="New cover"
              title={playlist.cover.stale ? 'The playlist has changed a lot since this cover was drawn' : undefined}
              className="group relative block w-full"
            >
              {cover}
              <span
                className={cn(
                  'absolute right-2.5 bottom-2.5 inline-flex items-center gap-1.5 rounded-full bg-ink-950/80 px-3 py-1.5 type-badge text-paper backdrop-blur transition',
                  !playlist.cover.stale && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                )}
              >
                <Palette className="size-3.5" /> New cover
              </span>
            </button>
          ) : (
            cover
          )
        }
        kicker="Playlist"
        title={
          <span className={cn(mine && 'cursor-text')} onClick={() => mine && setEditing(true)} title={mine ? 'Click to rename' : undefined}>
            {playlist.name}
          </span>
        }
        heading={
          editing ? (
            <EditDetails
              name={playlist.name}
              description={playlist.description}
              onCancel={() => setEditing(false)}
              onSave={(patch) => mutations.update.mutate({ id, ...patch }, { onSuccess: () => setEditing(false) })}
            />
          ) : undefined
        }
        meta={joinMeta(
          plural(items.length, 'song'),
          formatDuration(playlist.duration),
          unavailable > 0 && `${unavailable} not in library`,
          mine ? playlist.shared && <span title="Everyone on this server can see and play it">Shared with everyone</span> : `Shared by ${playlist.owner}`,
        )}
      >
        <ActionRow
          title={playlist.name}
          disabled={!playable.length}
          state={playState}
          onPlay={() =>
            playState !== 'idle' ? toggle() : playTracks(playable, 0, { shuffle: false, source: { label: playlist.name, href: `/playlists/${id}` } })
          }
          onShuffle={() => playTracks(playable, 0, { shuffle: true, source: { label: playlist.name, href: `/playlists/${id}` } })}
          download={{
            item: { key: `playlist:${id}`, title: playlist.name, subtitle: 'Playlist', coverUrl: playlist.cover.url, href: `/playlists/${id}` },
            tracks: playable,
          }}
          menu={{
            label: 'Playlist actions',
            items: [
              ...(mine ? [{ label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) }] : []),
              ...(playable.length
                ? [
                    { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(playable, 'next') },
                    { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(playable, 'end') },
                  ]
                : []),
              ...(mine && items.length ? [{ label: 'New cover…', icon: Palette, onSelect: () => setPickingCover(true) }] : []),
              ...(mine
                ? [
                    playlist.shared
                      ? { label: 'Stop sharing', icon: Lock, onSelect: () => mutations.update.mutate({ id, shared: false }) }
                      : { label: 'Share with everyone', icon: Users, onSelect: () => mutations.update.mutate({ id, shared: true }) },
                    { label: 'Delete playlist', icon: Trash2, onSelect: () => setConfirmDelete(true) },
                  ]
                : []),
            ],
          }}
        />
      </DetailHeader>
      {/* What it's about: after the row, so Play comes first on a phone. */}
      {playlist.description && !editing && (
        <p className="mt-6 max-w-2xl type-body text-paper-dim" onClick={() => mine && setEditing(true)}>
          {playlist.description}
        </p>
      )}

      {items.length === 0 ? (
        <p className="mt-12 max-w-md text-sm text-muted">
          This playlist is empty. Use <span className="text-paper-dim">Add to playlist…</span> from any song’s ⋯ menu, an
          album, the queue or Now Playing.
        </p>
      ) : (
        <Reorder.Group axis="y" values={items} onReorder={setItems} as="ol" className="mt-6 -mx-3 max-w-5xl md:mt-8">
          {items.map((item) => (
            <PlaylistRow
              key={item.itemId}
              item={item}
              editable={mine}
              bpm={item.track && tempos[item.track.recordingId]}
              onPlay={() => playFrom(item)}
              onDragEnd={commitOrder}
              onRemove={() => mutations.remove.mutate({ id, itemId: item.itemId })}
            />
          ))}
        </Reorder.Group>
      )}

      {mine && <PlaylistRecommendations playlistId={id} enabled={items.length > 0} />}

      <CoverPicker playlist={playlist} open={pickingCover} onClose={() => setPickingCover(false)} />

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete playlist?">
        <div className="p-5">
          <p className="text-sm text-paper-dim">
            “{playlist.name}” will be deleted. The songs stay in your library. This can’t be undone.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              pending={mutations.destroy.isPending}
              pendingLabel="Deleting…"
              onClick={() =>
                mutations.destroy.mutate(id, {
                  onSuccess: () => navigate('/playlists', { replace: true }),
                })
              }
            >
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function PlaylistRow({
  item,
  editable,
  bpm,
  onPlay,
  onDragEnd,
  onRemove,
}: {
  item: PlaylistItem;
  /** The viewer owns the playlist: drag to reorder, remove songs. */
  editable: boolean;
  /** Its measured tempo, if any. */
  bpm: number | undefined;
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
      {editable ? (
        <span
          role="button"
          aria-label={`Drag to reorder ${item.title}`}
          onPointerDown={(e) => controls.start(e)}
          onClick={(e) => e.stopPropagation()}
          className="grid h-9 cursor-grab touch-none place-items-center text-muted active:cursor-grabbing pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
        >
          <GripVertical className="size-4" />
        </span>
      ) : (
        <span />
      )}
      <div className="relative">
        <Cover src={track?.coverUrl} size={44} alt="" label={item.albumTitle} className="size-11 rounded-cover" />
        {isCurrent && (
          <div className="absolute inset-0 grid place-items-center rounded-cover bg-black/50">
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
      <span className="font-mono text-[13px] text-muted tabular">
        <Tempo bpm={bpm} />
        {track ? formatTime(track.duration) : ''}
      </span>
      <div onClick={(e) => e.stopPropagation()} className="pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100">
        <Menu
          items={[
            ...(track
              ? [
                  { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks([track], 'next') },
                  { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks([track], 'end') },
                  { label: 'Go to album', icon: Disc3, onSelect: () => navigate(`/albums/${track.albumId}`) },
                  { label: 'Go to artist', icon: Mic2, onSelect: () => navigate(`/artists/${track.artistId}`) },
                  { label: 'Show metadata', icon: Info, onSelect: () => useUI.getState().showMetadata(track.id) },
                ]
              : []),
            ...(editable ? [{ label: 'Remove from playlist', icon: X, onSelect: onRemove }] : []),
          ]}
        />
      </div>
    </Reorder.Item>
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
        className="w-full resize-none rounded-panel border border-line bg-ink-900/60 p-2 type-body text-paper-dim placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
