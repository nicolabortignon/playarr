import type { Track } from '@playarr/shared';
import { Pause, Play, Shuffle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import type { Download } from '../player/offline';
import { usePlayer } from '../player/store';
import { Button, type ButtonProps } from './Button';
import { DownloadButton } from './DownloadButton';
import { Menu, type MenuItem } from './Menu';

/**
 * What makes a worded button of the row round and wordless once the row narrows to a step (index.css: row-step-1
 * for Shuffle, row-step-2 for the page's own action). Its name and its title stay.
 */
const COMPACT = {
  1: { button: 'row-step-1:w-12 row-step-1:gap-0 row-step-1:px-0', label: 'row-step-1:sr-only' },
  2: { button: 'row-step-2:w-12 row-step-2:gap-0 row-step-2:px-0', label: 'row-step-2:sr-only' },
} as const;

/** For a status in the page action's place (a request's "Searching"): its words go at the same step as the action's. */
export const rowActionWords = COMPACT[2].label;

/** What Play says: Play, or for what's playing from this page, Pause and Resume. */
export type PlayState = 'idle' | 'playing' | 'paused';
const WORDS: Record<PlayState, string> = { idle: 'Play', playing: 'Pause', paused: 'Resume' };

/** Where the queue is when this page (`href`, its "Playing from") started it: playing, paused, or not this page's. */
export function usePlayState(href: string): PlayState {
  return usePlayer((s) => (s.pos >= 0 && s.source?.href === href ? (s.playing ? 'playing' : 'paused') : 'idle'));
}

export interface ActionRowProps {
  /** What's played, in the buttons' names: "Play OK Computer", "Shuffle OK Computer". */
  title: string;
  /** While what the page plays is playing, Play says Pause, then Resume; `onPlay` then pauses and resumes it. */
  state: PlayState;
  onPlay: () => void;
  onShuffle: () => void;
  /** Nothing to play yet (an empty playlist): Play and Shuffle can't be pressed. */
  disabled?: boolean;
  /** The page's own action: a RowAction ("New mix"), or a partial album's request. */
  action?: ReactNode;
  /** What the download button keeps on the device; none on an artist's page. */
  download?: { item: Omit<Download, 'tracks' | 'addedAt'>; tracks: Track[] };
  /** ⋯: the page's other actions. */
  menu?: { label?: string; items: MenuItem[] };
  className?: string;
}

/**
 * The row under the header of everything you can play (docs/design.md, The action row): Play, Shuffle, the page's own
 * action, Download, ⋯, in that order. Play is as wide as the widest of Play, Pause and Resume, so playing or pausing
 * moves nothing. The row never wraps: as its space narrows, Shuffle and then the page's action drop their words to
 * become icon buttons (keeping their names); then the gaps close up and Play drops its icon, keeping its word.
 */
export function ActionRow({ title, state, onPlay, onShuffle, disabled, action, download, menu, className }: ActionRowProps) {
  // What the row holds decides where it starts narrowing (index.css, row-step-*).
  const layout = action ? 'action' : download ? 'default' : 'short';
  return (
    <div data-layout={layout} className={cn('@container/action-row', className)}>
      {/*
       * Not a scroll container: one would clip Play's glow into a box. At its narrowest the row fits a 375 px phone;
       * on a narrower screen it runs on into the page's padding.
       */}
      <div className="flex items-center gap-3 row-step-3:gap-2">
        <PlayButton title={title} state={state} onPlay={onPlay} disabled={disabled} />
        <Button
          variant="secondary"
          size="large"
          icon={<Shuffle />}
          onClick={onShuffle}
          disabled={disabled}
          aria-label={`Shuffle ${title}`}
          title="Shuffle"
          className={COMPACT[1].button}
          labelClassName={COMPACT[1].label}
        >
          Shuffle
        </Button>
        {action}
        {download && <DownloadButton item={download.item} tracks={download.tracks} />}
        {menu && <Menu size="large" label={menu.label} items={menu.items} />}
      </div>
    </div>
  );
}

function PlayButton({ title, state, onPlay, disabled }: { title: string; state: PlayState; onPlay: () => void; disabled?: boolean }) {
  return (
    <Button variant="primary" size="large" onClick={onPlay} disabled={disabled} aria-label={`${WORDS[state]} ${title}`}>
      {/* Every word it can say, stacked in one cell: the button is as wide as the widest. */}
      <span className="grid">
        {(['idle', 'playing', 'paused'] as const).map((w) => (
          <span key={w} aria-hidden={w !== state || undefined} className={cn('col-start-1 row-start-1 flex items-center justify-center gap-2', w !== state && 'invisible')}>
            {/* At the row's narrowest, Play keeps its word but not its icon. */}
            {w === 'playing' ? <Pause className="size-5 fill-current row-step-3:hidden" /> : <Play className="size-5 fill-current row-step-3:hidden" />}
            {WORDS[w]}
          </span>
        ))}
      </span>
    </Button>
  );
}

/**
 * The page's own action in the row ("New mix", "Request the rest"): secondary and large, round and wordless (its title
 * says it) once the row is narrow.
 */
export function RowAction({ title, className, labelClassName, ...props }: Extract<ButtonProps, { to?: undefined }>) {
  const words = props.pending && props.pendingLabel ? props.pendingLabel : props.children;
  return (
    <Button
      variant="secondary"
      size="large"
      {...props}
      title={title ?? (typeof words === 'string' ? words : undefined)}
      className={cn(COMPACT[2].button, className)}
      labelClassName={cn(COMPACT[2].label, labelClassName)}
    />
  );
}
