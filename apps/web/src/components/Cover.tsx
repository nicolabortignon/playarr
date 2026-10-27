import { useState } from 'react';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';

interface CoverProps {
  src?: string;
  /** Rendered size in CSS px, used to request an appropriately sized image. */
  size: number;
  alt: string;
  className?: string;
  /** Text for the placeholder "record label" when there's no artwork. */
  label?: string;
  eager?: boolean;
}

export function Cover({ src, size, alt, className, label, eager }: CoverProps) {
  const url = sized(src, size);
  // State is keyed by URL so a reused slot (player bar, queue) never inherits a previous image's failure.
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const [errors, setErrors] = useState<{ url?: string; count: number }>({ count: 0 });
  const errorCount = errors.url === url ? errors.count : 0;
  const failed = errorCount > 1;
  // One automatic retry covers transient failures, e.g. the server restarting.
  const imgUrl = url && errorCount === 1 ? `${url}&retry=1` : url;

  return (
    <div className={cn('@container relative aspect-square overflow-hidden bg-ink-800', className)}>
      {(!url || failed) && <Placeholder label={label ?? alt} />}
      {imgUrl && !failed && (
        <img
          key={imgUrl}
          src={imgUrl}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setLoadedUrl(url)}
          onError={() => {
            const next = { url, count: errorCount + 1 };
            setTimeout(() => setErrors(next), errorCount === 0 ? 1500 : 0);
          }}
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-500',
            loadedUrl === url ? 'opacity-100' : 'opacity-0',
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
