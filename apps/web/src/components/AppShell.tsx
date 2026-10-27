import { Outlet, ScrollRestoration } from 'react-router';
import { AudioEngine } from '../player/AudioEngine';
import { useKeyboardShortcuts } from '../player/useKeyboardShortcuts';
import { BottomNav, Sidebar } from './Nav';
import { NowPlaying } from './NowPlaying';
import { MiniPlayer, PlayerBar } from './PlayerBar';
import { Toasts } from './Toasts';

export function AppShell() {
  useKeyboardShortcuts();
  return (
    <>
      <Sidebar />
      <main className="min-h-dvh pb-[calc(60px+60px+env(safe-area-inset-bottom)+2rem)] md:pb-[120px] md:pl-60">
        <Outlet />
      </main>
      <PlayerBar />
      <MiniPlayer />
      <BottomNav />
      <NowPlaying />
      <Toasts />
      <AudioEngine />
      <ScrollRestoration />
    </>
  );
}
