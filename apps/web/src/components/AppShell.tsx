import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { Outlet, ScrollRestoration } from 'react-router';
import { usePrefetchOnIntent } from '../lib/prefetch';
import { usePrefs, type MotionPref } from '../lib/prefs';
import { AudioEngine } from '../player/AudioEngine';
import { useKeyboardShortcuts } from '../player/useKeyboardShortcuts';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';
import { BottomNav, Sidebar } from './Nav';
import { NowPlaying } from './NowPlaying';
import { MiniPlayer, PlayerBar } from './PlayerBar';
import { Toasts } from './Toasts';

const REDUCED_MOTION = { system: 'user', reduce: 'always', full: 'never' } as const satisfies Record<MotionPref, string>;

/** Settings → Appearance → Motion: for motion's animations, and (through data-motion) for CSS transitions. */
function useMotionPref() {
  const motion = usePrefs((s) => s.motion);
  useEffect(() => {
    const root = document.documentElement;
    if (motion === 'system') delete root.dataset.motion;
    else root.dataset.motion = motion;
  }, [motion]);
  return REDUCED_MOTION[motion];
}

export function AppShell() {
  useKeyboardShortcuts();
  usePrefetchOnIntent();
  const reducedMotion = useMotionPref();
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <Sidebar />
      <main className="min-h-dvh pb-[calc(60px+60px+env(safe-area-inset-bottom)+2rem)] md:pb-[120px] md:pl-60">
        <Outlet />
      </main>
      <PlayerBar />
      <MiniPlayer />
      <BottomNav />
      <NowPlaying />
      <AddToPlaylistDialog />
      <Toasts />
      <AudioEngine />
      <ScrollRestoration />
    </MotionConfig>
  );
}
