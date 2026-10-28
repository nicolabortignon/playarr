import type { Track } from '@playarr/shared';
import { create } from 'zustand';

interface UIState {
  nowPlayingOpen: boolean;
  setNowPlaying: (open: boolean) => void;
  /** Songs waiting to be added by the "Add to playlist" dialog; [] = just create a playlist. */
  playlistPicker: Track[] | null;
  openPlaylistPicker: (tracks: Track[]) => void;
  closePlaylistPicker: () => void;
}

export const useUI = create<UIState>()((set) => ({
  nowPlayingOpen: false,
  setNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen }),
  playlistPicker: null,
  openPlaylistPicker: (tracks) => set({ playlistPicker: tracks.filter((t) => t.recordingId) }),
  closePlaylistPicker: () => set({ playlistPicker: null }),
}));
