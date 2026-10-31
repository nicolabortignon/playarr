import { useEffect, useRef, useState } from 'react';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';
import { markLoaded, NEAR_SCREEN, ON_SCREEN, queueImage, wasLoaded } from '../lib/imageQueue';
import { canObserve, useInView } from '../lib/viewport';

interface CoverProps {
  src?: string;
  /** Rendered size in CSS px, used to request an appropriately sized image. */
  size: number;
  alt: string;
  className?: string;
  /** Text for the placeholder "record label" when there's no artwork. */
  label?: string;
  /** Load at once, without waiting for a turn (the one big cover a page opens with). */
  eager?: boolean;
}

/** How far ahead of scrolling covers start loading. */
const AHEAD = '50% 0px';

export function Cover({ src, size, alt, className, label, eager }: CoverProps) {
  const url = sized(src, size);
  const ref = useRef<HTMLDivElement>(null);
  // State is keyed by URL so a reused slot (player bar, queue) never inherits a previous image's failure.
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const [errors, setErrors] = useState<{ url?: string; count: number }>({ count: 0 });
  const errorCount = errors.url === url ? errors.count : 0;
  const failed = errorCount > 1;
  // One automatic retry covers transient failures, e.g. the server restarting.
  const imgUrl = url && errorCount === 1 ? `${url}&retry=1` : url;

  // Covers wait for a turn to load (see imageQueue): on screen first, then those about to scroll in.
  const near = useInView(ref, AHEAD);
  const onScreen = useInView(ref, '0px');
  const [granted, setGranted] = useState<string>();
  const done = useRef<(() => void) | undefined>(undefined);
  const finish = () => {
    done.current?.();
    done.current = undefined;
  };
  const direct = !!imgUrl && (eager || !canObserve() || wasLoaded(imgUrl));
  const show = !!imgUrl && !failed && (direct || granted === imgUrl);

  useEffect(() => {
    if (!imgUrl || failed || direct || granted === imgUrl || !near) return;
    return queueImage(onScreen ? ON_SCREEN : NEAR_SCREEN, (release) => {
      done.current = release;
      setGranted(imgUrl);
    });
  }, [imgUrl, failed, direct, granted, near, onScreen]);
  // Give the turn back if this image goes away before it finished (a new track, the card unmounting).
  useEffect(() => finish, [imgUrl]);

  return (
    <div ref={ref} className={cn('@container relative aspect-square overflow-hidden bg-ink-800', className)}>
      {(!url || failed) && <Placeholder label={label ?? alt} />}
      {show && (
        <img
          key={imgUrl}
          src={imgUrl}
          alt={alt}
          loading={canObserve() ? 'eager' : 'lazy'}
          fetchPriority={eager || onScreen ? 'high' : 'low'}
          decoding="async"
          draggable={false}
          onLoad={() => {
            markLoaded(imgUrl);
            setLoadedUrl(url);
            finish();
          }}
          onError={() => {
            finish();
            const next = { url, count: errorCount + 1 };
            setTimeout(() => setErrors(next), errorCount === 0 ? 1500 : 0);
          }}
          className={cn(
            'absolute inset-0 h-full w-full object-cover',
            // Loaded before in this visit (scrolling back, another page): shown at once, no fade.
            wasLoaded(imgUrl) && loadedUrl !== url
              ? 'opacity-100'
              : cn('transition-opacity duration-500', loadedUrl === url ? 'opacity-100' : 'opacity-0'),
          )}
        />
      )}
    </div>
  );
}

/** A record-label style stand-in: concentric grooves and initials. */
function Placeholder({ label }: { label: string }) {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <div
      className="absolute inset-0 grid place-items-center"
      style={{
        background:
          'repeating-radial-gradient(circle at center, #1d1b17 0 2px, #171612 2px 5px), #171612',
      }}
    >
      <div className="grid aspect-square w-[38%] place-items-center rounded-full bg-accent/90 text-accent-ink">
        <span className="font-display text-[clamp(0.6rem,14cqi,3rem)] leading-none">{initials}</span>
      </div>
    </div>
  );
}
