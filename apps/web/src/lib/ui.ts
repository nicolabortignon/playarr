import type { Track } from '@playarr/shared';
import { create } from 'zustand';

/** What the column beside the page holds, at desktop widths (components/SideColumn.tsx), as on the iPad app. */
export type SideColumnView = 'queue' | 'lyrics';

/** Which cover carries the name a view transition moves between the player and Now Playing (lib/viewTransitions.ts). */
export type CoverMorph = 'player' | 'sheet';

interface UIState {
  nowPlayingOpen: boolean;
  /** Opens or closes Now Playing as a sheet sliding up or down (openNowPlaying grows it from the player's cover). */
  setNowPlaying: (open: boolean) => void;
  /** Now Playing was opened by growing the player's cover into it: it doesn't slide up as well. */
  nowPlayingGrown: boolean;
  /** Counts the times Now Playing closed at once, its cover shrinking back into the player's instead of the sheet sliding away. */
  nowPlayingCut: number;
  /** The cover (and with 'sheet', the sheet) named for the view transition running between them; null between transitions. */
  coverMorph: CoverMorph | null;
  /** Now Playing shows the words in place of the cover. */
  lyricsOpen: boolean;
  setLyrics: (open: boolean) => void;
  /** The column beside the page, wide enough: the queue or the words of the song playing; null while it's closed. */
  sideColumn: SideColumnView | null;
  setSideColumn: (view: SideColumnView | null) => void;
  /** The keyboard shortcuts, over everything (`?`). */
  shortcutsOpen: boolean;
  setShortcuts: (open: boolean) => void;
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
  setNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen, nowPlayingGrown: false }),
  nowPlayingGrown: false,
  nowPlayingCut: 0,
  coverMorph: null,
  lyricsOpen: false,
  setLyrics: (lyricsOpen) => set({ lyricsOpen }),
  sideColumn: null,
  setSideColumn: (sideColumn) => set({ sideColumn }),
  shortcutsOpen: false,
  setShortcuts: (shortcutsOpen) => set({ shortcutsOpen }),
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
