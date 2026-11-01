import type { MixMap } from '@playarr/mix';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';

/**
 * A song's energy per phrase as a strip of columns over its bar lines: the pieces the transition
 * view and Edit mix points both draw. One color (the accent), thin bar ticks underneath, and the
 * numbers in a table for anyone who can't read the picture.
 */

/** One 16-beat phrase of a song, placed in a picture. */
export interface PhraseColumn {
  /** Seconds into the song. */
  at: number;
  energy: number;
  /** Start and end on the picture's clock. */
  start: number;
  end: number;
  /** Position and width in the picture, 0–1. */
  left: number;
  width: number;
}

/** A bar line in the picture, 0–1; `phrase` marks every fourth (a phrase start). */
export interface BarTick {
  left: number;
  phrase: boolean;
}

/** Seconds per beat and where the first bar starts (the music's first downbeat), when the song has a beat. */
export function beatGrid(map: MixMap): { beat: number; firstBar: number } | undefined {
  if (!(map.bpm > 0)) return undefined;
  const beat = 60 / map.bpm;
  return { beat, firstBar: map.firstBeat + map.downbeatOffset * beat };
}

/**
 * A song's phrases and bars between `from` and `to` seconds of the picture's clock. `clock` turns a
 * time in the song into that clock (the identity for a picture of the whole song). Nothing without a beat.
 */
export function phrasesAndBars(map: MixMap, clock: (songTime: number) => number, from: number, to: number) {
  const span = to - from;
  const place = (t: number) => (Math.min(Math.max(t, from), to) - from) / span;
  const phrases: PhraseColumn[] = [];
  const bars: BarTick[] = [];
  const grid = beatGrid(map);
  if (grid) {
    const { beat, firstBar } = grid;
    map.phraseEnergy.forEach((energy, k) => {
      const at = firstBar + k * 16 * beat;
      const start = clock(at);
      const end = clock(Math.min(at + 16 * beat, map.duration));
      if (end <= from || start >= to) return;
      phrases.push({ at, energy, start, end, left: place(start), width: place(end) - place(start) });
    });
    for (let n = Math.max(0, Math.ceil(-firstBar / (4 * beat))); ; n++) {
      const at = firstBar + n * 4 * beat;
      if (at > map.duration) break;
      const t = clock(at);
      if (t > to) break;
      if (t >= from) bars.push({ left: place(t), phrase: n % 4 === 0 });
    }
  }
  return { phrases, bars };
}

/**
 * The phrase columns and the baseline, drawn inside a `relative` box the caller sizes (and may
 * overlay). `hovered`: the phrase under the pointer, the others dimmed.
 */
export function PhraseColumns({
  phrases,
  hovered,
  onHover,
}: {
  phrases: PhraseColumn[];
  hovered?: number | null;
  onHover?: (phrase: number) => void;
}) {
  return (
    <>
      <div className="absolute inset-x-0 bottom-0 h-px bg-line" />
      {phrases.map((p, k) => (
        // The whole phrase's height is the hover target, however low its energy.
        <div
          key={k}
          className="absolute inset-y-0 flex items-end"
          style={{ left: `${p.left * 100}%`, width: `calc(${p.width * 100}% - 2px)` }}
          onPointerEnter={onHover && (() => onHover(k))}
        >
          <div
            className={cn('w-full rounded-t-[4px] bg-accent transition-opacity duration-150', hovered != null && hovered !== k && 'opacity-45')}
            style={{ height: `max(${p.energy * 100}%, 2px)` }}
          />
        </div>
      ))}
    </>
  );
}

/** The bar lines under a strip: phrase starts taller and stronger. */
export function BarTicks({ bars }: { bars: BarTick[] }) {
  return (
    <div className="relative mt-0.5 h-1.5" aria-hidden>
      {bars.map((bar, k) => (
        <div key={k} className={cn('absolute top-0 w-px', bar.phrase ? 'h-1.5 bg-paper/40' : 'h-1 bg-paper/15')} style={{ left: `${bar.left * 100}%` }} />
      ))}
    </div>
  );
}

/** "1:04 · 72%": the phrase under the pointer, for the figure's caption. */
export function PhraseReadout({ phrase }: { phrase: PhraseColumn }) {
  return (
    <span className="text-[13px] text-paper-dim tabular" aria-live="polite">
      <span className="text-paper">{formatTime(phrase.at)}</span> · {Math.round(phrase.energy * 100)}%
    </span>
  );
}

export interface EnergyRow {
  /** The song's title, when the table covers more than one. */
  song?: string;
  at: number;
  energy: number;
  /** The extra column's text, when there is one. */
  extra?: string;
}

/** The strip's numbers, folded away under "Numbers". */
export function EnergyNumbers({ caption, rows, extraHeader }: { caption: string; rows: EnergyRow[]; extraHeader?: string }) {
  const songs = rows.some((r) => r.song !== undefined);
  return (
    <details className="mt-3">
      <summary className="cursor-pointer font-mono text-[10px] tracking-[0.15em] text-muted uppercase hover:text-paper">Numbers</summary>
      <table className="mt-2 w-full text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left font-mono text-[10px] tracking-[0.15em] text-muted uppercase">
            {songs && (
              <th scope="col" className="py-1 font-normal">
                Song
              </th>
            )}
            <th scope="col" className={cn('py-1 font-normal', songs && 'text-right')}>
              From
            </th>
            <th scope="col" className="py-1 text-right font-normal">
              Energy
            </th>
            {extraHeader && (
              <th scope="col" className="py-1 text-right font-normal">
                {extraHeader}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k} className="border-b border-line/60">
              {songs && (
                <th scope="row" className="max-w-0 truncate py-1 text-left font-normal text-paper-dim">
                  {r.song}
                </th>
              )}
              <td className={cn('py-1 text-paper tabular', songs && 'text-right')}>{formatTime(r.at)}</td>
              <td className="py-1 text-right text-paper tabular">{Math.round(r.energy * 100)}%</td>
              {extraHeader && <td className="py-1 text-right text-paper-dim">{r.extra}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
