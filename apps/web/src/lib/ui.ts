import type { Track } from '@playarr/shared';
import { create } from 'zustand';

interface UIState {
  nowPlayingOpen: boolean;
  setNowPlaying: (open: boolean) => void;
  /** Now Playing shows the words in place of the cover. */
  lyricsOpen: boolean;
  setLyrics: (open: boolean) => void;
  /** Songs waiting to be added by the "Add to playlist" dialog; [] = just create a playlist. */
  playlistPicker: Track[] | null;
  openPlaylistPicker: (tracks: Track[]) => void;
  closePlaylistPicker: () => void;
  /** The song whose "Show metadata" dialog is open. */
  metadataTrackId: number | null;
  showMetadata: (trackId: number) => void;
  closeMetadata: () => void;
  /** The song whose "Edit mix points" dialog is open. */
  mixPointsTrack: Track | null;
  editMixPoints: (track: Track) => void;
  closeMixPoints: () => void;
}

export const useUI = create<UIState>()((set) => ({
  nowPlayingOpen: false,
  setNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen }),
  lyricsOpen: false,
  setLyrics: (lyricsOpen) => set({ lyricsOpen }),
  playlistPicker: null,
  openPlaylistPicker: (tracks) => set({ playlistPicker: tracks.filter((t) => t.recordingId) }),
  closePlaylistPicker: () => set({ playlistPicker: null }),
  metadataTrackId: null,
  showMetadata: (metadataTrackId) => set({ metadataTrackId }),
  closeMetadata: () => set({ metadataTrackId: null }),
  mixPointsTrack: null,
  editMixPoints: (mixPointsTrack) => set({ mixPointsTrack }),
  closeMixPoints: () => set({ mixPointsTrack: null }),
}));
