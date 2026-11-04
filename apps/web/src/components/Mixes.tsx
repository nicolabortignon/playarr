import type { MixSummary } from '@playarr/shared';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { Cover } from './Cover';
import { orbitLayout, type OrbitCircle } from '../lib/mixOrbit';

/**
 * A mix's cover, drawn here rather than on the server: a wash of the mix's colour, one of its album covers as a big
 * circle off the top right with a thin ring round it, up to three more as small circles on the ring (tinted towards
 * the mix's colour), and its name. Where the circles go comes from the mix's key (lib/mixOrbit.ts), so a mix keeps its
 * look as its songs change, and looks the same in the app.
 */
export function MixCover({ mix, size, className }: { mix: Pick<MixSummary, 'key' | 'title' | 'covers' | 'hue'>; size: number; className?: string }) {
  const { hue, covers } = mix;
  const layout = orbitLayout(mix.key, covers.length);
  const place = (c: OrbitCircle): CSSProperties => ({
    left: `${(c.x - c.d / 2) * 100}%`,
    top: `${(c.y - c.d / 2) * 100}%`,
    width: `${c.d * 100}%`,
    height: `${c.d * 100}%`,
  });
  const ring = { x: layout.hero.x, y: layout.hero.y, d: layout.ring * 2 };
  return (
    <div
      className={cn('@container relative aspect-square overflow-hidden', className)}
      style={{
        background: `linear-gradient(165deg, oklch(0.5 0.15 ${hue}) 0%, oklch(0.34 0.11 ${hue}) 45%, oklch(0.18 0.06 ${hue}) 100%)`,
      }}
    >
      <div className="absolute rounded-full border border-paper/15" style={place(ring)} />
      {covers.length === 0 ? (
        // Nothing to show yet: a record's grooves round the label, in the mix's colour.
        <div
          className="absolute rounded-full"
          style={{
            ...place(layout.hero),
            background: `radial-gradient(circle closest-side, oklch(0.72 0.14 ${hue}) 0 33%, transparent 34%), repeating-radial-gradient(circle closest-side, oklch(0.17 0.04 ${hue}) 0 6%, oklch(0.24 0.05 ${hue}) 6% 7%)`,
          }}
        />
      ) : (
        <div className="absolute overflow-hidden rounded-full shadow-[0_18px_40px_-12px_rgb(0_0_0/0.7)] ring-1 ring-paper/10" style={place(layout.hero)}>
          <Cover src={covers[0]!} size={Math.round(size * layout.hero.d)} alt="" className="size-full rounded-none saturate-[0.9]" />
        </div>
      )}
      {layout.satellites.map((c, i) => (
        <div key={i} className="absolute isolate overflow-hidden rounded-full shadow-[0_8px_20px_-8px_rgb(0_0_0/0.7)] ring-1 ring-paper/10" style={place(c)}>
          <Cover src={covers[i + 1]!} size={Math.round(size * c.d)} alt="" className="size-full rounded-none saturate-[0.6]" />
          <div className="absolute inset-0 mix-blend-color" style={{ background: `oklch(0.62 0.14 ${hue})`, opacity: 0.5 }} />
        </div>
      ))}
      {layout.dot && <div className="absolute rounded-full" style={{ ...place(layout.dot), background: `oklch(0.78 0.13 ${hue})` }} />}
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
