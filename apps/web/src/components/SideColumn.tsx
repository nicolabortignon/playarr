import { X } from 'lucide-react';
import { motion } from 'motion/react';
import { useUI, type SideColumnView } from '../lib/ui';
import { useCurrentTrack } from '../player/store';
import { IconButton } from './Button';
import { Choice } from './Choice';
import { LyricsView } from './LyricsView';
import { QueueView } from './QueueView';

const VIEWS: { value: SideColumnView; label: string }[] = [
  { value: 'queue', label: 'Queue' },
  { value: 'lyrics', label: 'Lyrics' },
];

/**
 * The column beside any page at desktop widths, as on the iPad app: the queue, or the words of the song playing,
 * switched at its top, opened from the player bar's Queue and Lyrics (and Now Playing's Open queue). It runs from the
 * top of the window to the player bar; the page makes room for it (AppShell), and its grids and headers follow the
 * page's width rather than the window's (`page-lg:` and the rest, index.css).
 */
export function SideColumn() {
  const view = useUI((s) => s.sideColumn);
  const setView = useUI((s) => s.setSideColumn);
  const track = useCurrentTrack();
  if (!view) return null;
  return (
    <aside aria-label="Queue and lyrics" className="fixed inset-y-0 right-0 z-30 flex w-85 flex-col border-l border-line bg-ink-950 pb-[88px]">
      <header className="flex shrink-0 items-center gap-2 px-4 pt-5 pb-4">
        <Choice label="Show in the column" options={VIEWS} value={view} onChange={setView} className="min-w-0 flex-1" />
        <IconButton label="Close queue and lyrics" onClick={() => setView(null)}>
          <X className="size-5" />
        </IconButton>
      </header>
      {view === 'queue' ? (
        // Dragging a song within a list that scrolls: motion measures it against this scroller.
        <motion.div layoutScroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
          <QueueView narrow />
        </motion.div>
      ) : track ? (
        <LyricsView key={track.id} track={track} size="column" className="min-h-0 flex-1 px-6" />
      ) : (
        <p className="grid flex-1 place-items-center px-6 text-center font-display text-xl text-paper-dim">Nothing playing</p>
      )}
    </aside>
  );
}
