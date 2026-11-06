import type { PlaylistSummary, Track } from '@playarr/shared';
import { Check, Minus, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { usePlaylistMutations, usePlaylists, usePlaylistsHolding } from '../lib/queries';
import { useUI } from '../lib/ui';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { PlaylistCover } from './PlaylistCover';
import { TextField } from './TextField';

/** Global "Add to playlist" picker; opened via useUI().openPlaylistPicker(tracks). */
export function AddToPlaylistDialog() {
  const tracks = useUI((s) => s.playlistPicker);
  // The songs it was opened with, and which opening this is: kept while it closes, so what it shows doesn't change as
  // it goes, and a new opening starts afresh (a remount, by its key).
  const [shown, setShown] = useState<{ tracks: Track[]; opening: number } | null>(null);
  if (tracks && tracks !== shown?.tracks) setShown({ tracks, opening: (shown?.opening ?? 0) + 1 });
  return shown && <Picker key={shown.opening} tracks={shown.tracks} open={tracks !== null} />;
}

/**
 * The account's own playlists, each ticked when it already holds the songs (a dash when it holds some of them), to
 * choose one or several and add the songs to all of them at once. Or a new playlist, made with the songs.
 */
function Picker({ tracks, open }: { tracks: Track[]; open: boolean }) {
  const close = useUI((s) => s.closePlaylistPicker);
  const { data: playlists } = usePlaylists();
  const { data: holding } = usePlaylistsHolding(tracks.map((t) => t.recordingId), open);
  const { create, addToMany } = usePlaylistMutations();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(!tracks.length);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const mine = playlists?.filter((p) => p.mine) ?? [];
  // What the server counts: each song once, however many times it's in the list.
  const songs = new Set(tracks.map((t) => t.recordingId)).size;
  const title = !tracks.length ? 'New playlist' : tracks.length === 1 ? `Add “${tracks[0]!.title}”` : `Add ${tracks.length} songs`;
  const choosing = tracks.length > 0 && mine.length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name, recordingIds: tracks.map((t) => t.recordingId) },
      {
        onSuccess: (p) => {
          close();
          if (!tracks.length) navigate(`/playlists/${p.id}`);
        },
      },
    );
  };
  const choose = (id: number) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const add = () => addToMany.mutate({ ids: chosen, tracks }, { onSuccess: close });

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      // Kept in view while the playlists scroll.
      footer={
        choosing && (
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!chosen.length} pending={addToMany.isPending} pendingLabel="Adding…" onClick={add}>
              {chosen.length > 1 ? `Add to ${chosen.length} playlists` : 'Add'}
            </Button>
          </div>
        )
      }
    >
      {/* Rows lit on hover reach out by their own padding, so their words line up with the title. */}
      <div className="-m-3">
        {creating ? (
          <form onSubmit={submit} className="flex items-center gap-2 p-3">
            <TextField
              label="Playlist name"
              hideLabel
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Playlist name"
              maxLength={100}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="primary" disabled={!name.trim()} pending={create.isPending} pendingLabel="Creating…">
              Create
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex w-full items-center gap-3 rounded-panel p-3 text-left type-body text-paper transition hover:bg-paper/[0.05]"
          >
            <span className="grid size-12 place-items-center rounded-cover border border-dashed border-paper/25 text-accent">
              <Plus className="size-5" />
            </span>
            New playlist
          </button>
        )}

        {choosing && (
          <ul aria-label="Your playlists">
            {mine.map((p) => (
              <li key={p.id}>
                <PlaylistChoice playlist={p} holds={holding?.[p.id] ?? 0} of={songs} chosen={chosen.includes(p.id)} onToggle={() => choose(p.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/**
 * A playlist to add to: a checkbox (the circle on the right). On its cover, a tick when it already holds every one of
 * the songs, a dash when it holds some; its line says so in words too.
 */
function PlaylistChoice({
  playlist: p,
  holds,
  of,
  chosen,
  onToggle,
}: {
  playlist: PlaylistSummary;
  /** How many of the songs it already holds. */
  holds: number;
  /** How many songs are being added. */
  of: number;
  chosen: boolean;
  onToggle: () => void;
}) {
  const all = holds > 0 && holds >= of;
  const some = holds > 0 && !all;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={chosen}
      onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-panel p-3 text-left transition hover:bg-paper/[0.05]"
    >
      <span className="relative shrink-0">
        <PlaylistCover cover={p.cover} size={48} name={p.name} className="size-12 rounded-cover" />
        {(all || some) && (
          <span
            aria-hidden
            className={cn(
              'absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full ring-2 ring-ink-850',
              all ? 'bg-success text-ink-950' : 'bg-ink-600 text-paper',
            )}
          >
            {all ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate type-body text-paper">{p.name}</span>
        <span className="block truncate type-meta text-muted">
          {plural(p.trackCount, 'song')}
          {all ? ' · already in it' : some ? ` · ${holds} of ${of} already in it` : ''}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-full border transition',
          chosen ? 'border-accent bg-accent text-accent-ink' : 'border-paper/25',
        )}
      >
        {chosen && <Check className="size-4" />}
      </span>
    </button>
  );
}
