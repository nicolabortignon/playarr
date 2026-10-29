import { CircleArrowDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { useIsKept, useOffline } from '../player/offline';

const R = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** Shows that a song is on this device, or how far along its download is. */
export function OfflineMark({ fileId, className }: { fileId: number; className?: string }) {
  const kept = useIsKept(fileId);
  const progress = useOffline((s) => (s.active?.fileId === fileId ? s.active.loaded / s.active.total : null));

  if (progress !== null) {
    const pct = Math.round(progress * 100);
    return (
      <svg viewBox="0 0 14 14" role="img" aria-label={`Downloading, ${pct}%`} className={cn('size-3.5 shrink-0 -rotate-90', className)}>
        <title>{`Downloading · ${pct}%`}</title>
        <circle cx="7" cy="7" r={R} fill="none" strokeWidth="1.75" className="stroke-paper/15" />
        <circle
          cx="7"
          cy="7"
          r={R}
          fill="none"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray={`${CIRCUMFERENCE * progress} ${CIRCUMFERENCE}`}
          className="stroke-accent transition-[stroke-dasharray] duration-300"
        />
      </svg>
    );
  }
  if (!kept) return null;
  return (
    <span title="On this device" className={cn('inline-flex shrink-0 text-accent/80', className)}>
      <CircleArrowDown role="img" aria-label="On this device" className="size-3.5" />
    </span>
  );
}
