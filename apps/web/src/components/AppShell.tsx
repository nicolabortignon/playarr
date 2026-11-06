import { MotionConfig } from 'motion/react';
import { useEffect } from 'react';
import { Outlet, ScrollRestoration } from 'react-router';
import { usePlayerAccent } from '../lib/accent';
import { usePrefetchOnIntent } from '../lib/prefetch';
import { useSongMap, useWatchRequests } from '../lib/queries';
import { cn } from '../lib/cn';
import { usePrefs, type MotionPref } from '../lib/prefs';
import { useUI } from '../lib/ui';
import { useColumnLayout, useDesktopLayout } from '../lib/useMediaQuery';
import { AudioEngine } from '../player/AudioEngine';
import { upNext } from '../player/decks';
import { useCurrentTrack, usePlayer } from '../player/store';
import { useKeyboardShortcuts } from '../player/useKeyboardShortcuts';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';
import { TrackMetadataDialog } from './TrackMetadataDialog';
import { MixPointsDialog } from './MixPointsDialog';
import { BottomNav, Sidebar } from './Nav';
import { NowPlaying } from './NowPlaying';
import { MiniPlayer, PlayerBar } from './PlayerBar';
import { ShortcutsOverlay } from './Shortcuts';
import { SideColumn } from './SideColumn';
import { StatsForNerds } from './StatsForNerds';
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

/**
 * The accent and the favicon follow the song playing, unless Settings → Appearance fixes the color, gliding over one
 * beat of it (plan 7 §1). The next song's mix map is asked for ahead, so its tempo is known as its color comes; the song
 * playing's is only read, when it's here (asked for ahead, or by the now-playing bars or Now Playing), as asking now
 * would come too late for the color that just came. A component of its own: a new song re-renders it alone, not the shell.
 */
export function FollowTheSong() {
  const track = useCurrentTrack();
  const next = usePlayer(upNext);
  const map = useSongMap(track, false);
  useSongMap(next);
  usePlayerAccent(track, map?.bpm);
  return null;
}

export function AppShell() {
  useKeyboardShortcuts();
  usePrefetchOnIntent();
  const reducedMotion = useMotionPref();
  useWatchRequests();
  // Only one layout's chrome is mounted: the hidden one would still poll and re-render every second.
  const desktop = useDesktopLayout();
  // The queue and lyrics column, beside the page when the window is wide enough (else Queue opens the Queue page).
  const columnFits = useColumnLayout();
  const column = useUI((s) => s.sideColumn) !== null && desktop && columnFits;
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      {desktop && <Sidebar />}
      <main className={cn('min-h-dvh pb-[calc(60px+60px+env(safe-area-inset-bottom)+2rem)] md:pb-[120px] md:pl-60', column && 'pr-85')}>
        {/* The page's own width sets its breakpoints (page-lg: and the rest, index.css): narrower beside the column. */}
        <div className="@container/page">
          <Outlet />
        </div>
      </main>
      {column && <SideColumn />}
      {desktop ? (
        <PlayerBar />
      ) : (
        <>
          <MiniPlayer />
          <BottomNav />
        </>
      )}
      <NowPlaying />
      <StatsForNerds />
      <AddToPlaylistDialog />
      <TrackMetadataDialog />
      <MixPointsDialog />
      <ShortcutsOverlay />
      <Toasts />
      <AudioEngine />
      <FollowTheSong />
      <ScrollRestoration />
    </MotionConfig>
  );
}
