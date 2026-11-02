import { create } from 'zustand';

// How close the last changeover between two files came (Stats for nerds shows it): the files of a DJ
// transition join A's and B's own files where they hold the same sound, and the closer in step the
// two are when one takes over, the less of the join can be heard.

export interface JoinReport {
  /** Which changeover: into the transition, or out of it into the next song. */
  join: string;
  /** How far apart the two files were when the new one took over (the median of the last few looks), in ms; null if never measured. */
  gapMs: number | null;
  /** How long getting in step took, in ms. */
  tookMs: number;
  /** Measured on the sound as it comes out (desktop), rather than by the elements' reported times. */
  heard?: boolean;
}

export const useJoins = create<{ last: JoinReport | null }>()(() => ({ last: null }));

export const reportJoin = (report: JoinReport) => useJoins.setState({ last: report });
