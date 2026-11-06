import type { CoverLayout, PlaylistCoverInfo, PlaylistDetail } from '@playarr/shared';
import { Check, Dices, Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { api, sized } from '../lib/api';
import { cn } from '../lib/cn';
import { usePlaylistMutations } from '../lib/queries';
import { Button } from './Button';
import { Dialog } from './Dialog';

const STYLES: { layout: CoverLayout; label: string }[] = [
  { layout: 'currents', label: 'Currents' },
  { layout: 'colonies', label: 'Colonies' },
  { layout: 'horizon', label: 'Horizon' },
  { layout: 'ridges', label: 'Ridges' },
  { layout: 'grooves', label: 'Grooves' },
  { layout: 'blocks', label: 'Blocks' },
];

/** What each style draws, so a cover reads as a portrait of the music rather than decoration. */
const COVER_STORY: Record<CoverLayout, string> = {
  ridges: 'Each line is a song, traced from its loudness over time.',
  grooves: 'A record of the playlist: each band of grooves is a song, as wide as it is long.',
  blocks: 'A tile per song, sized by its length; each shape follows how it sounds.',
  horizon: 'Each hill is a song’s loudness over time. The slower the music, the bigger the sun.',
  currents: 'Each ribbon belongs to a song: a steady beat flows smoothly, free time swirls; louder songs run wider.',
  colonies: 'Each style is a slime-mold species in its own color, growing with its songs’ tempo and beat.',
};

/**
 * "New cover": one candidate per style, drawn from the playlist's current songs; Shuffle re-rolls them. Under them,
 * what the chosen style draws and what the songs are like (kept here, off the playlist's header, so Play comes first).
 */
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
        <Button icon={<Dices />} onClick={() => setVariant((v) => v + 1)}>
          Shuffle
        </Button>
        <Button
          variant="primary"
          icon={<Check />}
          pending={setCover.isPending}
          pendingLabel="Saving…"
          onClick={() => setCover.mutate({ id: playlist.id, layout: chosen, variant }, { onSuccess: onClose })}
        >
          Use this
        </Button>
      </div>
      <AboutCover cover={playlist.cover} layout={chosen} />
    </div>
  );
}

/** About this cover: what the chosen style draws, from what the songs are like (their tempo, styles, years, energy). */
function AboutCover({ cover, layout }: { cover: PlaylistCoverInfo; layout: CoverLayout }) {
  const heading = useId();
  const facts = [
    cover.tempo && `${cover.tempo} BPM`,
    cover.styles.length && cover.styles.join(' / '),
    cover.era && (cover.era[0] === cover.era[1] ? String(cover.era[0]) : `${cover.era[0]}–${cover.era[1]}`),
    `energy ${Math.round(cover.energy * 100)}%`,
  ].filter(Boolean);
  return (
    <section aria-labelledby={heading} className="mt-6 border-t border-line pt-5">
      <h3 id={heading} className="type-kicker text-muted">
        About this cover
      </h3>
      {cover.pending && !cover.frozen ? (
        <p className="mt-2 flex items-center gap-2 type-small text-paper-dim">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          Listening to the songs to draw the cover… {cover.analyzed} of {cover.total}
        </p>
      ) : (
        <>
          <p className="mt-2 type-small text-paper-dim">{COVER_STORY[layout]}</p>
          <p className="mt-1.5 type-meta text-muted">{facts.join(' · ')}</p>
        </>
      )}
      {cover.stale && <p className="mt-2 type-small text-paper-dim">The playlist has changed a lot since its cover was drawn.</p>}
    </section>
  );
}

function Candidate({ src, label, selected, onSelect }: { src: string; label: string; selected: boolean; onSelect: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`${label} cover`} className="group text-left">
      <div
        className={cn(
          'relative aspect-square overflow-hidden rounded-cover bg-ink-800 ring-2 ring-offset-2 ring-offset-ink-850 transition',
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
      <span className={cn('mt-2 block type-kicker', selected ? 'text-accent' : 'text-muted')}>{label}</span>
    </button>
  );
}
