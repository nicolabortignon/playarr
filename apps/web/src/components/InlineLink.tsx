import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * A name inside a row (artist, album) that links on its own: above the row's own button, which covers the row
 * (components/SongRow.tsx), so pressing the name opens it rather than playing the song.
 */
export function InlineLink({ to, title, children }: { to?: string; title?: string; children: ReactNode }) {
  if (!to) return <>{children}</>;
  return (
    <Link to={to} title={title} onClick={(e) => e.stopPropagation()} className="relative z-10 transition hover:text-paper hover:underline">
      {children}
    </Link>
  );
}
