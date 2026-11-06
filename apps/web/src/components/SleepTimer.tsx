import { AlarmClockOff, Moon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import { sleepLabel, useSleep } from '../player/sleep';
import { Menu, type MenuItem } from './Menu';

const MINUTES = [15, 30, 45, 60, 90];

/** Now Playing → sleep timer: stop after a while, or at the end of this song. */
export function SleepTimer({ className }: { className?: string }) {
  const { endsAt, endOfSong, sleepIn, sleepAtEndOfSong, cancel } = useSleep();
  const [, tick] = useState(0);
  // The minutes left count down while it's shown.
  useEffect(() => {
    if (endsAt === null) return;
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [endsAt]);

  const label = sleepLabel(endsAt, endOfSong);
  const items: MenuItem[] = [
    ...MINUTES.map((m) => ({ label: m < 60 ? `In ${m} minutes` : m === 60 ? 'In an hour' : `In ${m / 60} hours`, icon: Moon, onSelect: () => sleepIn(m) })),
    { label: 'At the end of this song', icon: Moon, onSelect: sleepAtEndOfSong },
    ...(label ? [{ label: 'Turn off the timer', icon: AlarmClockOff, onSelect: cancel }] : []),
  ];
  return (
    <Menu
      label={label ? `Sleep timer: ${label}` : 'Sleep timer'}
      // Round until it counts down; then as wide as the time left.
      className={cn('w-auto min-w-11 px-2.5 text-paper pointer-fine:w-auto pointer-fine:min-w-9', label && 'text-accent', className)}
      trigger={
        <span className="flex items-center gap-1.5">
          <Moon className="size-[18px]" />
          {label && <span className="font-mono text-[11px] tracking-wider whitespace-nowrap uppercase">{label}</span>}
        </span>
      }
      items={items}
    />
  );
}
