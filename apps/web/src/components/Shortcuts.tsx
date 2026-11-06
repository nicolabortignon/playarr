import { Fragment, useId } from 'react';
import { cn } from '../lib/cn';
import { useUI } from '../lib/ui';
import { Dialog } from './Dialog';

export interface Shortcut {
  /** Each way to press it, as its keys: [['Shift', '←'], ['Shift', '→']]. */
  keys: string[][];
  action: string;
}

/**
 * What the keyboard does (player/useKeyboardShortcuts.ts, and a list's rows: components/SongRow.tsx), as the two sides
 * of a record: playing, then getting around. Settings → Playback lists them, and `?` shows them over any page.
 */
export const SHORTCUT_SIDES: { side: 'A' | 'B'; title: string; shortcuts: Shortcut[] }[] = [
  {
    side: 'A',
    title: 'Playing',
    shortcuts: [
      { keys: [['Space']], action: 'Play or pause' },
      { keys: [['←'], ['→']], action: 'Back or ahead 10 seconds' },
      { keys: [['Shift', '←'], ['Shift', '→']], action: 'Previous or next song' },
      { keys: [['↑'], ['↓']], action: 'Volume up or down' },
      { keys: [['M']], action: 'Mute or unmute' },
      { keys: [['S']], action: 'Shuffle on or off' },
      { keys: [['L']], action: 'Add the song playing to Favorites, or remove it' },
    ],
  },
  {
    side: 'B',
    title: 'Getting around',
    shortcuts: [
      { keys: [['/']], action: 'Search' },
      { keys: [['?']], action: 'Show the shortcuts' },
      { keys: [['Enter']], action: 'Play the song in focus' },
      { keys: [['Shift', 'F10'], ['Menu']], action: 'Open the song’s menu' },
      { keys: [['↑'], ['↓']], action: 'Move a song up or down by its handle' },
      { keys: [['Esc']], action: 'Close a menu, a dialog or Now playing' },
    ],
  },
];

/**
 * "Shift + ← or Shift + →": each way to press a shortcut, its keys as keycaps. Short of room, the ways go on lines of
 * their own, each kept whole.
 */
export function Keys({ keys, className }: { keys: string[][]; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-1.5 gap-y-1', className)}>
      {keys.map((combo, i) => (
        <span key={combo.join('+')} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {i > 0 && <span className="type-small text-muted">or</span>}
          {combo.map((key, j) => (
            <Fragment key={key}>
              {j > 0 && <span className="type-small text-muted">+</span>}
              <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-cover border border-line bg-ink-800 px-1.5 type-badge text-paper-dim">
                {key}
              </kbd>
            </Fragment>
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * `?` anywhere (but in a field): the shortcuts as the back of a sleeve lists its songs, side A and side B, numbered,
 * a dotted line running from each to its keys. Escape, or Close, puts it away.
 */
export function ShortcutsOverlay() {
  const open = useUI((s) => s.shortcutsOpen);
  const setOpen = useUI((s) => s.setShortcuts);
  const id = useId();
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" wide>
      <div className="grid gap-8 p-5 md:grid-cols-2 md:gap-10 md:p-7">
        {SHORTCUT_SIDES.map(({ side, title, shortcuts }) => (
          <section key={side} aria-labelledby={`${id}-${side}`}>
            <h3 id={`${id}-${side}`} className="mb-4 type-kicker text-muted">
              Side {side} · {title}
            </h3>
            <ol className="space-y-3">
              {shortcuts.map(({ keys, action }, i) => (
                <li key={action} className="flex items-baseline gap-3">
                  <span className="w-6 shrink-0 type-meta text-muted">
                    {side}
                    {i + 1}
                  </span>
                  <span className="min-w-0 type-body text-paper">{action}</span>
                  <span aria-hidden className="min-w-4 flex-1 border-b border-dotted border-paper/20" />
                  {/* Short of room, the keys wrap before the words do. */}
                  <Keys keys={keys} className="shrink-8 justify-end" />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      <p className="border-t border-line px-5 py-4 type-small text-muted md:px-7">They work anywhere in Playarr, except while you’re typing.</p>
    </Dialog>
  );
}
