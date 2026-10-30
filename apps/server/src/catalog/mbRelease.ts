/** A MusicBrainz release (one edition of an album) with its track list, as matching uses it. */
export interface MbTrack {
  disc: number;
  position: number;
  title: string;
  length: number; // seconds, 0 if unknown
  recordingId: string;
}

export interface MbReleaseInfo {
  id: string;
  title: string;
  date?: string;
  artistName: string;
  artistId?: string;
  releaseGroup: { id: string; title: string; primaryType?: string; secondaryTypes: string[]; firstReleaseDate?: string };
  tracks: MbTrack[];
}
