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
      // Side A is the song playing: "the song playing" goes without saying.
      { keys: [['L']], action: 'Add to Favorites, or remove' },
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
      { keys: [['↑'], ['↓']], action: 'Move a song by its handle' },
      { keys: [['Esc']], action: 'Close a menu, a dialog or Now playing' },
    ],
  },
];

const Cap = ({ name }: { name: string }) => (
  <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-cover border border-line bg-ink-800 px-1.5 type-badge text-paper-dim">{name}</kbd>
);
const Word = ({ children }: { children: string }) => <span className="type-small text-muted">{children}</span>;

/**
 * The keys held with the last one, when every way to press a shortcut holds the same ones (Shift + ← or Shift + →):
 * they're written once, "Shift + ← or →".
 */
function sharedKeys(keys: string[][]): string[] {
  const [first, ...rest] = keys;
  if (!first || !rest.length || first.length < 2) return [];
  const held = first.slice(0, -1);
  return rest.every((combo) => combo.length === first.length && held.every((key, i) => combo[i] === key)) ? held : [];
}

/**
 * Each way to press a shortcut, its keys as keycaps: "Esc", "Shift + F10 or Menu", "Shift + ← or →" (the keys held
 * with both written once). Short of room, the ways go on lines of their own, each kept whole.
 */
export function Keys({ keys, className }: { keys: string[][]; className?: string }) {
  const held = sharedKeys(keys);
  const ways = held.length ? keys.map((combo) => combo.slice(held.length)) : keys;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-1.5 gap-y-1', className)}>
      {held.length > 0 && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {held.map((key) => (
            <Fragment key={key}>
              <Cap name={key} />
              <Word>+</Word>
            </Fragment>
          ))}
        </span>
      )}
      {ways.map((combo, i) => (
        <span key={combo.join('+')} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {i > 0 && <Word>or</Word>}
          {combo.map((key, j) => (
            <Fragment key={key}>
              {j > 0 && <Word>+</Word>}
              <Cap name={key} />
            </Fragment>
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * `?` anywhere (but in a field): the shortcuts as the back of a sleeve lists its songs, side A and side B, numbered,
 * a dotted line running from each to its keys, every one on a line of its own. The sides stand side by side only where
 * that line fits (a 1024 px window); narrower, side B follows side A. Escape, or Close, puts it away.
 */
export function ShortcutsOverlay() {
  const open = useUI((s) => s.shortcutsOpen);
  const setOpen = useUI((s) => s.setShortcuts);
  const id = useId();
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      size="wider"
      footer={<p className="type-small text-muted">They work anywhere in Playarr, except while you’re typing.</p>}
    >
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
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
                  <span aria-hidden className="min-w-3 flex-1 border-b border-dotted border-paper/20" />
                  {/* Short of room, the keys wrap before the words do. */}
                  <Keys keys={keys} className="shrink-8 justify-end" />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
