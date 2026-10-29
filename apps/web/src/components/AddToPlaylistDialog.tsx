import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { plural } from '../lib/format';
import { usePlaylistMutations, usePlaylists } from '../lib/queries';
import { useUI } from '../lib/ui';
import { Dialog } from './Dialog';
import { PlaylistCover } from './PlaylistCover';

/** Global "Add to playlist" picker; opened via useUI().openPlaylistPicker(tracks). */
export function AddToPlaylistDialog() {
  const tracks = useUI((s) => s.playlistPicker);
  const close = useUI((s) => s.closePlaylistPicker);
  const open = tracks !== null;
  const title = !tracks?.length ? 'New playlist' : tracks.length === 1 ? `Add “${tracks[0]!.title}”` : `Add ${tracks.length} songs`;

  return (
    <Dialog open={open} onClose={close} title={title}>
      {/* Remount per opening so the form starts fresh. */}
      {open && <Picker key={tracks.map((t) => t.id).join(',')} />}
    </Dialog>
  );
}

function Picker() {
  const tracks = useUI((s) => s.playlistPicker) ?? [];
  const close = useUI((s) => s.closePlaylistPicker);
  const { data: playlists } = usePlaylists();
  const { create, add } = usePlaylistMutations();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(!tracks.length);
  const [name, setName] = useState('');

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

  return (
    <div className="p-2">
      {creating ? (
        <form onSubmit={submit} className="flex gap-2 p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Playlist name"
            aria-label="Playlist name"
            maxLength={100}
            className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 text-paper placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="h-11 rounded-lg bg-accent px-4 font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-40"
          >
            Create
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex w-full items-center gap-3 rounded-lg p-3 text-left text-paper transition hover:bg-paper/[0.05]"
        >
          <span className="grid size-12 place-items-center rounded-md border border-dashed border-paper/25 text-accent">
            <Plus className="size-5" />
          </span>
          New playlist
        </button>
      )}

      {tracks.length > 0 &&
        playlists?.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={add.isPending}
            onClick={() => add.mutate({ id: p.id, tracks }, { onSuccess: close })}
            className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition hover:bg-paper/[0.05] disabled:opacity-50"
          >
            <PlaylistCover cover={p.cover} size={48} name={p.name} className="size-12 shrink-0 rounded-md" />
            <span className="min-w-0">
              <span className="block truncate text-paper">{p.name}</span>
              <span className="block font-mono text-[11px] text-muted">{plural(p.trackCount, 'song')}</span>
            </span>
          </button>
        ))}
    </div>
  );
}
