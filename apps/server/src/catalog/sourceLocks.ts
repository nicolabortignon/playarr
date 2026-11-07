/**
 * One thing at a time on a source's files: a sync (listing the folder and reading its tags, then writing what it
 * found) and an organize or its undo (moving files and writing where they went). A sync that listed the folder before
 * a move and wrote after it would put the old paths back, and the moved songs would lose their matches.
 */
export class SourceLocks {
  /** Each source's last piece of work, which the next waits for. */
  private readonly tails = new Map<number, Promise<unknown>>();

  /** `work` once the source's earlier work is done, failed or not; the source's later work waits for it. */
  run<T>(sourceId: number, work: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(sourceId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    this.tails.set(sourceId, tail);
    void tail.then(() => {
      if (this.tails.get(sourceId) === tail) this.tails.delete(sourceId);
    });
    return run;
  }
}
