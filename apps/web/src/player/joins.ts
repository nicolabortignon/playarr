import { create } from 'zustand';

// How close the last changeover between two files came (Stats for nerds shows it): the files of a DJ
// transition join A's and B's own files where they hold the same sound, and the closer in step the
// two are when one takes over, the less of the join can be heard.

export interface JoinReport {
  /** Which changeover: 'mix in' (A's own file into the transition, lined up on A) or 'mix out' (into B's own file, lined up on the transition). */
  join: string;
  /** The two songs of the transition: "Into the Trees → Nanana". */
  songs?: string;
  /**
   * How far apart the two files were when first measured on the sound, in ms: positive when the new file
   * was ahead of the old one (heard later in the music), negative when behind.
   */
  foundMs?: number;
  /** How far apart the two files were when the new one took over (the median of the last few looks), in ms; null if never measured. */
  gapMs: number | null;
  /** How long getting in step took, in ms. */
  tookMs: number;
  /** Measured on the sound as it comes out (desktop), rather than by the elements' reported times. */
  heard?: boolean;
  /** Why it was lined up by the elements' times after all, where it could have been measured on the sound. */
  fellBack?: string;
}

/** The last changeover, and the last of each kind (into the transition, into the next song). */
export const useJoins = create<{ last: JoinReport | null; byJoin: Record<string, JoinReport> }>()(() => ({ last: null, byJoin: {} }));

export const reportJoin = (report: JoinReport) => useJoins.setState((s) => ({ last: report, byJoin: { ...s.byJoin, [report.join]: report } }));
