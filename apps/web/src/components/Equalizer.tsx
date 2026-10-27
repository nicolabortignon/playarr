import { cn } from '../lib/cn';

/** Animated bars marking the playing track; freezes when paused. */
export function Equalizer({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {[0.9, 0.5, 0.75].map((h, i) => (
        <span
          key={i}
          className="w-[3px] origin-bottom rounded-[1px] bg-accent"
          style={{
            height: `${h * 100}%`,
            animation: `eq 0.${7 + i}s ease-in-out ${i * 0.15}s infinite alternate`,
            animationPlayState: playing ? 'running' : 'paused',
          }}
        />
      ))}
      <style>{'@keyframes eq{0%{transform:scaleY(.25)}100%{transform:scaleY(1)}}'}</style>
    </span>
  );
}
