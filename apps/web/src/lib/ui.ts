import { create } from 'zustand';

interface UIState {
  nowPlayingOpen: boolean;
  setNowPlaying: (open: boolean) => void;
}

export const useUI = create<UIState>()((set) => ({
  nowPlayingOpen: false,
  setNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen }),
}));
