import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useClock, usePlayer } from './store';

/** Space play/pause · ←/→ seek 10s · Shift+←/→ prev/next · ↑/↓ volume · M mute · S shuffle · / search */
export function useKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const p = usePlayer.getState();
      const clock = useClock.getState();

      switch (e.key) {
        case ' ':
          if (target.closest('button, a, [role="slider"]')) return;
          e.preventDefault();
          p.toggle();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) p.next();
          else clock.seek(Math.min(clock.duration, clock.time + 10));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) p.prev(clock.time);
          else clock.seek(Math.max(0, clock.time - 10));
          break;
        case 'ArrowUp':
          if (target.closest('[role="slider"]')) return;
          e.preventDefault();
          p.setVolume(p.volume + 0.05);
          break;
        case 'ArrowDown':
          if (target.closest('[role="slider"]')) return;
          e.preventDefault();
          p.setVolume(p.volume - 0.05);
          break;
        case 'm':
        case 'M':
          p.toggleMute();
          break;
        case 's':
        case 'S':
          p.toggleShuffle();
          break;
        case '/':
          e.preventDefault();
          navigate('/search');
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}
