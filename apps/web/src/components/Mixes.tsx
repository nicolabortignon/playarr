import type { MixSummary } from '@playarr/shared';
import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';
import { accentHue, knownAccentHue } from '../lib/color';
import { plural } from '../lib/format';
import { Cover } from './Cover';
import { orbitLayout, toneFromCovers, washStops, type OrbitCircle, type WashStop } from '../lib/mixOrbit';

/**
 * A mix's cover, drawn here rather than on the server: a wash of the mix's colour (for Vibes, Discovery and On Repeat,
 * running between the colours of its first two covers, faded in once they're read), one of its album covers as a big
 * circle off the top right with a thin ring round it, up to three more as small circles on the ring (tinted towards
 * the mix's colour), and its name. Where the circles go comes from the mix's key (lib/mixOrbit.ts), so a mix keeps its
 * look as its songs change, and looks the same in the app.
 */
export function MixCover({ mix, size, className }: { mix: Pick<MixSummary, 'key' | 'kind' | 'title' | 'covers' | 'hue'>; size: number; className?: string }) {
  const { covers } = mix;
  const layout = orbitLayout(mix.key, covers.length);
  const base = washStops(mix.hue);
  const tones = useCoverTones(mix);
  const toned = tones && washStops(tones.from, tones.to);
  // The small circles, the dot and the record take the middle of the wash.
  const hue = (toned ?? base)[2]!.h;
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
      style={{ background: gradient(base) }}
    >
      <div className="absolute inset-0 transition-opacity duration-700" style={{ background: gradient(toned ?? base), opacity: toned ? 1 : 0 }} />
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

/** The web's `linear-gradient(165deg, …)` of a wash: mostly down, a little to the right. */
const gradient = (stops: WashStop[]) => `linear-gradient(165deg, ${stops.map((s) => `oklch(${s.l} ${s.c} ${s.h}) ${s.at * 100}%`).join(', ')})`;

/**
 * For the mixes whose wash comes from their covers: the colours of the first two (the first's alone when the second
 * has none), null until they're read, or when neither has a colour to give.
 */
function useCoverTones(mix: Pick<MixSummary, 'kind' | 'covers'>): { from: number; to: number } | null {
  const urls = toneFromCovers(mix.kind) ? mix.covers.slice(0, 2).map((u) => sized(u, 96)!) : [];
  const key = urls.join(' ');
  const [read, setRead] = useState(() => ({ key, hues: urls.map(knownAccentHue) }));
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void Promise.all(key.split(' ').map(accentHue)).then((hues) => !cancelled && setRead({ key, hues }));
    return () => {
      cancelled = true;
    };
  }, [key]);
  if (!key || read.key !== key) return null;
  const [first, second] = read.hues;
  const from = first ?? second;
  return from == null ? null : { from, to: second ?? from };
}

/** A mix on Home: its cover (with its name) and a line about it. */
export function MixCard({ mix, className, style }: { mix: MixSummary; className?: string; style?: CSSProperties }) {
  return (
    <Link to={`/mixes/${mix.key}`} className={cn('group block animate-rise', className)} style={style}>
      <MixCover
        mix={mix}
        size={220}
        className="rounded-[4px] shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)] ring-1 ring-paper/5"
      />
      <div className="mt-3 min-w-0">
        <div className="truncate text-[15px] leading-snug text-paper">{mix.subtitle}</div>
        <div className="truncate font-mono text-[12px] text-muted">{plural(mix.trackCount, 'song')}</div>
      </div>
    </Link>
  );
}
