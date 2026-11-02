/**
 * A song id the API takes: a MusicBrainz recording id, `track:<n>` for a Lidarr track without one,
 * or `local:<hash>` for a song from a folder source that isn't matched on MusicBrainz (see catalog/folder.ts).
 */
export const RECORDING_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|track:\d+|local:[0-9a-f]{16})$/i;
