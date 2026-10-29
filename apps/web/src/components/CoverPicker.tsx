import type { CoverLayout, PlaylistDetail } from '@playarr/shared';
import { Check, Dices, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { api, sized } from '../lib/api';
import { cn } from '../lib/cn';
import { usePlaylistMutations } from '../lib/queries';
import { Dialog } from './Dialog';

const STYLES: { layout: CoverLayout; label: string }[] = [
  { layout: 'currents', label: 'Currents' },
  { layout: 'colonies', label: 'Colonies' },
  { layout: 'horizon', label: 'Horizon' },
  { layout: 'ridges', label: 'Ridges' },
  { layout: 'grooves', label: 'Grooves' },
  { layout: 'blocks', label: 'Blocks' },
];

/** "New cover": one candidate per style, drawn from the playlist's current songs; Shuffle re-rolls them. */
export function CoverPicker({ playlist, open, onClose }: { playlist: PlaylistDetail; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New cover" wide>
      {/* Remount per opening, so it starts from fresh variations. */}
      {open && <Picker playlist={playlist} onClose={onClose} />}
    </Dialog>
  );
}

function Picker({ playlist, onClose }: { playlist: PlaylistDetail; onClose: () => void }) {
  const { setCover } = usePlaylistMutations();
  const [variant, setVariant] = useState(playlist.cover.variant + 1);
  const [chosen, setChosen] = useState<CoverLayout>(playlist.cover.layout);

  return (
    <div className="p-4 sm:p-5">
      <p className="mb-4 text-sm text-muted">Drawn from the {playlist.trackCount} songs in this playlist as they are now.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        {STYLES.map(({ layout, label }) => (
          <Candidate
            key={`${layout}-${variant}`}
            src={sized(api.playlistCoverPreview(playlist.id, layout, variant), 240)!}
            label={label}
            selected={chosen === layout}
            onSelect={() => setChosen(layout)}
          />
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setVariant((v) => v + 1)}
          className="inline-flex h-10 items-center gap-2 rounded-full border border-paper/15 px-4 text-paper transition hover:border-paper/35 hover:bg-paper/5"
        >
          <Dices className="size-4" /> Shuffle
        </button>
        <button
          type="button"
          disabled={setCover.isPending}
          onClick={() => setCover.mutate({ id: playlist.id, layout: chosen, variant }, { onSuccess: onClose })}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-50"
        >
          {setCover.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Use this
        </button>
      </div>
    </div>
  );
}

function Candidate({ src, label, selected, onSelect }: { src: string; label: string; selected: boolean; onSelect: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`${label} cover`} className="group text-left">
      <div
        className={cn(
          'relative aspect-square overflow-hidden rounded-md bg-ink-800 ring-2 ring-offset-2 ring-offset-ink-850 transition',
          selected ? 'ring-accent' : 'ring-transparent group-hover:ring-paper/25',
        )}
      >
        {/* Some styles simulate for a few seconds; keep the spinner up until they arrive. */}
        {!loaded && <Loader2 className="absolute inset-0 m-auto size-5 animate-spin text-muted" />}
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          className={cn('absolute inset-0 size-full transition-opacity duration-500', loaded ? 'opacity-100' : 'opacity-0')}
        />
      </div>
      <span className={cn('mt-2 block font-mono text-[11px] tracking-[0.15em] uppercase', selected ? 'text-accent' : 'text-muted')}>{label}</span>
    </button>
  );
}
