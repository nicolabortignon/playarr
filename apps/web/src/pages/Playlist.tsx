import type { PlaylistItem } from '@playarr/shared';
import { ListMusic, ListPlus, Lock, Palette, Pencil, Trash, Users, X } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ActionRow, usePlayState } from '../components/ActionRow';
import { Button, IconButton } from '../components/Button';
import { Cover } from '../components/Cover';
import { DetailHeader, DetailHeaderSkeleton, joinMeta } from '../components/DetailHeader';
import { ConfirmDialog } from '../components/Dialog';
import { CoverPicker } from '../components/CoverPicker';
import type { MenuItem } from '../components/Menu';
import { moveItems, usePlaylistMenu } from '../components/menus';
import { PlaylistCover } from '../components/PlaylistCover';
import { PlaylistRecommendations } from '../components/PlaylistRecommendations';
import { BackButton } from '../components/Section';
import { EmptyState, ErrorState, SongRowsSkeleton } from '../components/States';
import { ListRow, SongRow, type RowReorder } from '../components/SongRow';
import { cn } from '../lib/cn';
import { formatDuration, plural } from '../lib/format';
import { restorePlaylistItem, setPlaylistShared, usePlaylist, usePlaylistMutations, useTempos } from '../lib/queries';
import { toast, toastWithUndo } from '../lib/toast';
import { usePlayer } from '../player/store';

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
  const playable = items.flatMap((i) => (i.track ? [i.track] : []));
  const mine = !!playlist?.mine;
  const menu = usePlaylistMenu(
    { id },
    {
      tracks: playable,
      own: mine
        ? [
            { label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) },
            ...(items.length ? [{ label: 'New cover…', icon: Palette, onSelect: () => setPickingCover(true) }] : []),
            playlist?.shared
              ? { label: 'Stop sharing', icon: Lock, onSelect: () => stopSharing() }
              : { label: 'Share with everyone', icon: Users, onSelect: () => mutations.update.mutate({ id, shared: true }) },
            { label: 'Delete playlist', icon: Trash, onSelect: () => setConfirmDelete(true) },
          ]
        : [],
    },
  );

  // Local copy so drag-reordering is instant; resync whenever the server copy changes.
  useEffect(() => {
    if (playlist) setItems(playlist.items);
  }, [playlist]);

  /** Stop sharing: at once, with Undo. */
  const stopSharing = () => {
    const name = playlist?.name ?? '';
    mutations.update.mutate(
      { id, shared: false },
      { onSuccess: () => toastWithUndo(`Stopped sharing “${name}”`, () => void setPlaylistShared(id, true)) },
    );
  };
  /**
   * Remove from playlist: at once, with Undo, which puts the song back where it was. A song no longer in the library
   * can't be added again, so its removal has no Undo.
   */
  const removeItem = (item: PlaylistItem, index: number) => {
    const name = playlist?.name ?? '';
    const after = items[index - 1]?.itemId;
    setItems((list) => list.filter((i) => i.itemId !== item.itemId));
    mutations.remove.mutate(
      { id, itemId: item.itemId },
      {
        onSuccess: () => {
          const message = `Removed “${item.title}” from “${name}”`;
          if (item.track) toastWithUndo(message, () => void restorePlaylistItem(id, item.recordingId, { after, index }));
          else toast(message);
        },
      },
    );
  };

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !playlist) {
    return (
      <div className="px-5 pt-6 md:px-10 md:pt-14">
        <DetailHeaderSkeleton />
        <SongRowsSkeleton className="mt-6 -mx-3 max-w-5xl md:mt-8" />
      </div>
    );
  }

  const source = { label: playlist.name, href: `/playlists/${id}` };
  const playFrom = (item: PlaylistItem) => {
    const index = playable.findIndex((t) => t === item.track);
    if (index >= 0) playTracks(playable, index, { shuffle: false, source });
  };
  const commitOrder = (order = items) => {
    const ids = order.map((i) => i.itemId);
    if (ids.join() !== playlist.items.map((i) => i.itemId).join()) mutations.reorder.mutate({ id, itemIds: ids });
  };
  /** Move up and Move down (the menu, the handle's arrow keys): what dragging does, saved at once. */
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    setItems(next);
    commitOrder(next);
  };
  const unavailable = items.length - playable.length;
  // Another account's shared playlist plays here; only its owner changes it.
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
        // Its owner renames it from the title (a click, or the pencil beside it) or from ⋯.
        title={
          <span className={cn(mine && 'cursor-text')} onClick={() => mine && setEditing(true)}>
            {playlist.name}
          </span>
        }
        titleAction={
          mine && (
            <IconButton
              label="Rename playlist"
              title="Rename"
              onClick={() => setEditing(true)}
              className="pointer-fine:opacity-0 pointer-fine:group-hover/title:opacity-100 pointer-fine:focus-visible:opacity-100"
            >
              <Pencil className="size-5" />
            </IconButton>
          )
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
          onPlay={() => (playState !== 'idle' ? toggle() : playTracks(playable, 0, { shuffle: false, source }))}
          onShuffle={() => playTracks(playable, 0, { shuffle: true, source })}
          download={{
            item: { key: `playlist:${id}`, title: playlist.name, subtitle: 'Playlist', coverUrl: playlist.cover.url, href: `/playlists/${id}` },
            tracks: playable,
          }}
          menu={{ label: `More for “${playlist.name}”`, items: menu }}
        />
      </DetailHeader>
      {/* What it's about: after the row, so Play comes first on a phone. */}
      {playlist.description && !editing && (
        <p className="mt-6 max-w-2xl type-body text-paper-dim" onClick={() => mine && setEditing(true)}>
          {playlist.description}
        </p>
      )}

      {items.length === 0 ? (
        mine ? (
          <EmptyState
            icon={ListPlus}
            title="This playlist is waiting for its first song."
            hint="Choose Add to playlist… in any song’s ⋯ menu."
          />
        ) : (
          <EmptyState icon={ListMusic} title="Nothing in this playlist yet." />
        )
      ) : (
        <Reorder.Group axis="y" values={items} onReorder={setItems} as="ol" className="mt-6 -mx-3 max-w-5xl md:mt-8">
          {items.map((item, i) => (
            <PlaylistRow
              key={item.itemId}
              item={item}
              editable={mine}
              bpm={item.track && tempos[item.track.recordingId]}
              onPlay={() => playFrom(item)}
              onDragEnd={() => commitOrder()}
              own={
                mine
                  ? [
                      ...moveItems(i, items.length, move),
                      { label: 'Remove from playlist', icon: X, onSelect: () => removeItem(item, i) },
                    ]
                  : []
              }
              onMove={(by) => move(i, i + by)}
            />
          ))}
        </Reorder.Group>
      )}

      {mine && <PlaylistRecommendations playlistId={id} enabled={items.length > 0} />}

      <CoverPicker playlist={playlist} open={pickingCover} onClose={() => setPickingCover(false)} />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${playlist.name}”?`}
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        pending={mutations.destroy.isPending}
        onConfirm={() => mutations.destroy.mutate(id, { onSuccess: () => navigate('/playlists', { replace: true }) })}
      >
        <p>
          The playlist goes for good{playlist.shared ? ', for everyone it’s shared with' : ''}.
          {items.length === 1 ? ' Its song stays in your library.' : items.length > 1 ? ` Its ${items.length} songs stay in your library.` : ''}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** A song of the playlist: the one song row, with its owner's Move up, Move down and Remove after a line. */
function PlaylistRow({
  item,
  editable,
  bpm,
  onPlay,
  onDragEnd,
  own,
  onMove,
}: {
  item: PlaylistItem;
  /** The viewer owns the playlist: drag to reorder, move and remove songs. */
  editable: boolean;
  /** Its measured tempo, if any. */
  bpm: number | undefined;
  onPlay: () => void;
  onDragEnd: () => void;
  /** Its owner's actions, after the song menu's. */
  own: MenuItem[];
  onMove: (by: -1 | 1) => void;
}) {
  const controls = useDragControls();
  const { track } = item;
  const reorder: RowReorder | undefined = editable ? { value: item, controls, label: `Drag to reorder ${item.title}`, onDragEnd, onMove } : undefined;

  if (track) return <SongRow track={track} onPlay={onPlay} bpm={bpm} reorder={reorder} menu={{ own }} />;
  // No longer in the library: in its place, greyed, with only the owner's actions.
  return (
    <ListRow
      missing
      hint="Not in your library"
      lead={<Cover size={44} alt="" label={item.albumTitle} className="size-11 shrink-0 rounded-cover" />}
      title={item.title}
      subtitle={
        <>
          {item.artistName} <span className="text-ink-600">·</span> {item.albumTitle}
          <span className="ml-2 type-badge">Not in library</span>
        </>
      }
      reorder={reorder}
      menu={{ label: `More for “${item.title}”`, items: own }}
    />
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
    if (e.key === 'Escape') {
      // Escape is the field's own here (it cancels the rename): nothing under it closes (lib/overlays.ts).
      e.preventDefault();
      onCancel();
    }
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
