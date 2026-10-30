import { cn } from '../lib/cn';
import { formatWait } from '../lib/format';
import { useMusicBrainzStatus } from '../lib/queries';
import { useDelayedFlag } from '../lib/useDelayedFlag';

/**
 * Explains a MusicBrainz wait instead of leaving a bare spinner. Appears only once a lookup has
 * taken a moment, and says when Playarr's own background matching is ahead in the line.
 */
export function SlowLookup({ active, what, className }: { active: boolean; what: string; className?: string }) {
  const shown = useDelayedFlag(active, 1500);
  const { data } = useMusicBrainzStatus(shown);
  if (!shown) return null;
  const queue = data && data.background > 0 && data.queued > 1;
  return (
    <p role="status" className={cn('flex max-w-prose items-start gap-2.5 text-[13px] leading-relaxed text-muted', className)}>
      <span className="mt-[7px] size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span>
        Asking MusicBrainz for {what}. It answers about one request per second
        {queue ? (
          <>
            , and Playarr is also identifying your folder music, so there’s a line: about{' '}
            <span className="font-mono text-paper-dim">{formatWait(data.etaSeconds)}</span> to go.
          </>
        ) : (
          '.'
        )}
      </span>
    </p>
  );
}
