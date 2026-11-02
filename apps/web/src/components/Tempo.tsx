/** A song's measured tempo, shown before its length in song lists ("130.3"); nothing until it's measured. */
export function Tempo({ bpm }: { bpm: number | undefined }) {
  if (!bpm) return null;
  return (
    <span className="mr-2.5 text-muted/70" title={`${bpm.toFixed(2)} BPM, as Playarr measured it`}>
      {bpm.toFixed(1)}
    </span>
  );
}
