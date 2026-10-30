import type { FavoriteTrack } from '@playarr/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useToggleFavorite } from '../lib/queries';
import { currentTrack, useClock, usePlayer } from './store';

/** Space play/pause · ←/→ seek 10s · Shift+←/→ prev/next · ↑/↓ volume · M mute · S shuffle · L favorite · / search */
export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { mutate: toggleFavorite } = useToggleFavorite();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A control already used the key (e.g. arrows moving between radio options in Settings).
      if (e.defaultPrevented) return;
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
        case 'l':
        case 'L': {
          const track = currentTrack(p);
          if (!track?.recordingId) break;
          const favs = client.getQueryData<FavoriteTrack[]>(['favorites']) ?? [];
          toggleFavorite({ track, favorite: !favs.some((f) => f.recordingId === track.recordingId) });
          break;
        }
        case '/':
          e.preventDefault();
          navigate('/search');
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, client, toggleFavorite]);
}
