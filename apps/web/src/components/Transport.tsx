import { Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { useClock, usePlayer } from '../player/store';
import { Slider } from './Slider';

export function PlayPauseButton({ size = 'md', className }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const playing = usePlayer((s) => s.playing);
  const toggle = usePlayer((s) => s.toggle);
  const hasTrack = usePlayer((s) => s.pos >= 0);
  const loading = useClock((s) => s.loading && playing);
  const dims = { sm: 'size-10', md: 'size-11', lg: 'size-[4.5rem]' }[size];
  const icon = { sm: 'size-[18px]', md: 'size-5', lg: 'size-8' }[size];
  return (
    <button
      type="button"
      aria-label={playing ? 'Pause' : 'Play'}
      disabled={!hasTrack}
      onClick={toggle}
      className={cn(
        'relative grid shrink-0 place-items-center rounded-full bg-paper text-ink-900 transition duration-200 hover:scale-[1.04] active:scale-95 disabled:opacity-40',
        dims,
        className,
      )}
    >
      {loading ? (
        <Loader2 className={cn(icon, 'animate-spin')} />
      ) : playing ? (
        <Pause className={cn(icon, 'fill-current')} />
      ) : (
        <Play className={cn(icon, 'ml-[8%] fill-current')} />
      )}
    </button>
  );
}

export function Transport({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const p = usePlayer.getState;
  const big = size === 'lg';
  const side = cn('relative grid place-items-center rounded-full transition hover:text-paper', big ? 'size-12' : 'size-9');
  const skip = cn('grid place-items-center rounded-full text-paper transition hover:scale-105 active:scale-95', big ? 'size-14' : 'size-10');

  return (
    <div className={cn('flex items-center', big ? 'justify-between' : 'gap-3')}>
      <button
        type="button"
        aria-label="Shuffle"
        aria-pressed={shuffle}
        onClick={() => p().toggleShuffle()}
        className={cn(side, shuffle ? 'text-accent' : 'text-muted')}
      >
        <Shuffle className={big ? 'size-5' : 'size-4'} />
        {shuffle && <span className="absolute mt-6 size-1 rounded-full bg-accent" />}
      </button>
      <button type="button" aria-label="Previous" onClick={() => p().prev(useClock.getState().time)} className={skip}>
        <SkipBack className={cn('fill-current', big ? 'size-7' : 'size-[18px]')} />
      </button>
      <PlayPauseButton size={big ? 'lg' : 'sm'} />
      <button type="button" aria-label="Next" onClick={() => p().next()} className={skip}>
        <SkipForward className={cn('fill-current', big ? 'size-7' : 'size-[18px]')} />
      </button>
      <button
        type="button"
        aria-label={`Repeat: ${repeat}`}
        onClick={() => p().cycleRepeat()}
        className={cn(side, repeat !== 'off' ? 'text-accent' : 'text-muted')}
      >
        {repeat === 'one' ? <Repeat1 className={big ? 'size-5' : 'size-4'} /> : <Repeat className={big ? 'size-5' : 'size-4'} />}
      </button>
    </div>
  );
}

export function SeekBar({ className, compact }: { className?: string; compact?: boolean }) {
  const time = useClock((s) => s.time);
  const duration = useClock((s) => s.duration);
  const buffered = useClock((s) => s.buffered);
  const seek = useClock((s) => s.seek);
  const timeCls = 'font-mono text-[11px] text-muted tabular';

  if (compact) {
    return (
      <div className={cn('flex items-center gap-3', className)}>
        <span className={cn(timeCls, 'w-10 text-right')}>{formatTime(time)}</span>
        <Slider label="Seek" value={time} max={duration} buffered={buffered} onChange={seek} step={10} valueText={formatTime} tooltip={formatTime} className="flex-1" />
        <span className={cn(timeCls, 'w-10')}>{formatTime(duration)}</span>
      </div>
    );
  }
  return (
    <div className={className}>
      <Slider label="Seek" value={time} max={duration} buffered={buffered} onChange={seek} step={10} valueText={formatTime} className="h-6" />
      <div className={cn('mt-1 flex justify-between', timeCls)}>
        <span>{formatTime(time)}</span>
        <span>-{formatTime(Math.max(0, duration - time))}</span>
      </div>
    </div>
  );
}
