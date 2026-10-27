import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '../lib/cn';

interface SliderProps {
  value: number;
  max: number;
  /** Called continuously while dragging (live) when `live`, otherwise on release. */
  onChange: (value: number) => void;
  buffered?: number;
  live?: boolean;
  step?: number;
  label: string;
  valueText?: (v: number) => string;
  /** Shows a hover tooltip with this formatter (pointer devices). */
  tooltip?: (v: number) => string;
  className?: string;
}

/** Pointer + keyboard accessible slider used for seeking and volume. */
export function Slider({
  value,
  max,
  onChange,
  buffered,
  live,
  step,
  label,
  valueText,
  tooltip,
  className,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const shown = drag ?? value;
  const pct = max > 0 ? Math.min(100, (shown / max) * 100) : 0;
  const bufPct = max > 0 && buffered ? Math.min(100, (buffered / max) * 100) : 0;

  const valueAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * max;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (max <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = valueAt(e.clientX);
    setDrag(v);
    if (live) onChange(v);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') setHover(valueAt(e.clientX));
    if (drag === null) return;
    const v = valueAt(e.clientX);
    setDrag(v);
    if (live) onChange(v);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (drag === null) return;
    onChange(valueAt(e.clientX));
    setDrag(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const s = step ?? max / 20;
    const map: Record<string, number> = {
      ArrowRight: value + s,
      ArrowUp: value + s,
      ArrowLeft: value - s,
      ArrowDown: value - s,
      Home: 0,
      End: max,
    };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation();
      onChange(Math.min(max, Math.max(0, map[e.key]!)));
    }
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={valueText?.(shown)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      className={cn('group relative flex h-5 cursor-pointer touch-none items-center select-none', className)}
    >
      <div ref={trackRef} className="relative h-[3px] w-full rounded-full bg-paper/12 transition-[height] group-hover:h-[5px]">
        <div className="absolute inset-y-0 left-0 rounded-full bg-paper/12" style={{ width: `${bufPct}%` }} />
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full bg-paper transition-colors group-hover:bg-accent', drag !== null && 'bg-accent')}
          style={{ width: `${pct}%` }}
        />
        <div
          className={cn(
            'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-paper shadow-[0_0_0_4px_rgb(0_0_0/0.25)] transition-transform',
            drag !== null ? 'scale-110' : 'scale-0 group-hover:scale-100 group-focus-visible:scale-100',
          )}
          style={{ left: `${pct}%` }}
        />
      </div>
      {tooltip && hover !== null && max > 0 && (
        <div
          className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[11px] text-paper shadow-lg"
          style={{ left: `${(hover / max) * 100}%` }}
        >
          {tooltip(hover)}
        </div>
      )}
    </div>
  );
}
