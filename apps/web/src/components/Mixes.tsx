import type { MixSummary } from '@playarr/shared';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { Cover } from './Cover';

/**
 * A mix's cover, drawn here rather than on the server: up to four of its album covers under a wash
 * of the mix's colour, with its name. Cheap to make, and each mix keeps a recognisable colour.
 */
export function MixCover({ mix, size, className }: { mix: Pick<MixSummary, 'title' | 'covers' | 'hue'>; size: number; className?: string }) {
  const { hue, covers } = mix;
  const grid = covers.length >= 4 ? covers.slice(0, 4) : covers.slice(0, 1);
  return (
    <div
      className={cn('@container relative aspect-square overflow-hidden', className)}
      style={{ background: `oklch(0.32 0.09 ${hue})` }}
    >
      {grid.length > 0 && (
        <div className={cn('absolute inset-0 grid saturate-[0.85]', grid.length === 4 && 'grid-cols-2')}>
          {grid.map((src) => (
            <Cover key={src} src={src} size={grid.length === 4 ? size / 2 : size} alt="" className="rounded-none" />
          ))}
        </div>
      )}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(165deg, oklch(0.62 0.17 ${hue} / 0.35) 0%, oklch(0.42 0.14 ${hue} / 0.72) 45%, oklch(0.2 0.07 ${hue} / 0.95) 100%)`,
        }}
      />
      <div className="absolute inset-x-0 bottom-0 p-[7cqi]">
        <div className="font-mono text-[4.6cqi] tracking-[0.2em] text-paper/75 uppercase">Made for you</div>
        <div className="mt-[1.5cqi] font-display text-[12.5cqi] leading-[0.95] text-balance text-paper drop-shadow-[0_2px_12px_rgb(0_0_0/0.4)]">
          {mix.title}
        </div>
      </div>
    </div>
  );
}

/** A mix on Home: its cover (with its name) and a line about it. */
export function MixCard({ mix, className, style }: { mix: MixSummary; className?: string; style?: CSSProperties }) {
  return (
    <Link to={`/mixes/${mix.key}`} className={cn('group block animate-rise', className)} style={style}>
      <MixCover
        mix={mix}
        size={220}
        className="rounded-[4px] shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)] ring-1 ring-paper/5 transition duration-500 ease-out-expo group-hover:-translate-y-1"
      />
      <div className="mt-3 min-w-0">
        <div className="truncate text-[15px] leading-snug text-paper">{mix.subtitle}</div>
        <div className="truncate font-mono text-[12px] text-muted">{plural(mix.trackCount, 'song')}</div>
      </div>
    </Link>
  );
}
