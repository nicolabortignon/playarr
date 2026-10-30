import type { AudioFormat } from '@playarr/shared';
import { cn } from '../lib/cn';
import { formatBadge, isHiRes } from '../lib/format';
import { usePrefs } from '../lib/prefs';

export function FormatBadge({ format, className }: { format?: AudioFormat; className?: string }) {
  const shown = usePrefs((s) => s.formatBadges);
  const text = formatBadge(format);
  if (!text || !shown) return null;
  const hiRes = isHiRes(format);
  return (
    <span
      title={hiRes ? 'Hi-Res lossless' : format?.lossless ? 'Lossless' : 'Lossy'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-px font-mono text-[10px] leading-4 tracking-wider uppercase',
        hiRes ? 'border-accent/50 text-accent' : 'border-line text-muted',
        className,
      )}
    >
      {format?.lossless && <span className={cn('size-1 rounded-full', hiRes ? 'bg-accent' : 'bg-muted')} />}
      {text}
    </span>
  );
}
