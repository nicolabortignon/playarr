import { ChevronRight, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';

/**
 * A row that opens a page, in a list of places to go (Library's, Settings' on a phone): the page's glyph in a tile of
 * the accent, its name, a number about it, and a chevron.
 */
export function NavRow({ to, state, icon: Icon, label, detail }: { to: string; state?: unknown; icon: LucideIcon; label: string; detail?: string }) {
  return (
    <Link to={to} state={state} className="flex items-center gap-4 rounded-lg px-2 py-3 transition hover:bg-paper/[0.04]">
      <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1 type-body text-paper">{label}</span>
      {detail && <span className="type-meta text-muted">{detail}</span>}
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted" />
    </Link>
  );
}
