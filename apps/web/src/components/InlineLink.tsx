import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** A name inside a clickable row (artist, album) that links on its own without triggering the row. */
export function InlineLink({ to, title, children }: { to?: string; title?: string; children: ReactNode }) {
  if (!to) return <>{children}</>;
  return (
    <Link to={to} title={title} onClick={(e) => e.stopPropagation()} className="transition hover:text-paper hover:underline">
      {children}
    </Link>
  );
}
