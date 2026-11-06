import type { AudioFormat } from '@playarr/shared';
import { cn } from '../lib/cn';
import { formatBadge, formatDetails, isHiRes } from '../lib/format';
import { usePrefs } from '../lib/prefs';

/**
 * A song's or an album's format, saying only what's worth saying (docs/design.md, Words): "MP3", "MP3 · 128 kbps",
 * "FLAC", "FLAC · 24/96". A dot for lossless, the accent for Hi-Res; its title has the full details.
 */
export function FormatBadge({ format, className }: { format?: AudioFormat; className?: string }) {
  const shown = usePrefs((s) => s.formatBadges);
  const badge = formatBadge(format);
  if (!badge || !format || !shown) return null;
  const hiRes = isHiRes(format);
  return (
    <span
      title={formatDetails(format)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-cover border px-1.5 py-px type-badge leading-4 whitespace-nowrap',
        hiRes ? 'border-accent/50 text-accent' : 'border-line text-muted',
        className,
      )}
    >
      {format.lossless && <span aria-hidden className={cn('size-1 rounded-full', hiRes ? 'bg-accent' : 'bg-muted')} />}
      {badge.codec}
      {badge.detail && (
        <>
          {' · '}
          {/* Units read as written ("kbps"), not in the badge's capitals. */}
          <span className="normal-case">{badge.detail}</span>
        </>
      )}
    </span>
  );
}
