import { ListMusic } from 'lucide-react';
import { cn } from '../lib/cn';
import { Cover } from './Cover';

/** 2×2 mosaic of album covers (a single cover with fewer than four), or a placeholder. */
export function PlaylistCover({ covers, size, name, className }: { covers: string[]; size: number; name: string; className?: string }) {
  if (covers.length >= 4) {
    return (
      <div className={cn('grid aspect-square grid-cols-2 overflow-hidden bg-ink-800', className)}>
        {covers.slice(0, 4).map((c) => (
          <Cover key={c} src={c} size={size / 2} alt="" className="rounded-none" />
        ))}
      </div>
    );
  }
  if (covers.length) return <Cover src={covers[0]} size={size} alt={name} className={className} />;
  return (
    <div
      className={cn('grid aspect-square place-items-center bg-gradient-to-br from-ink-700 to-ink-800 text-accent', className)}
      aria-label={name}
    >
      <ListMusic className="size-1/3" strokeWidth={1.5} />
    </div>
  );
}
