import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Show a long list a screenful at a time: the first `first` items, then `step` more whenever the end of
 * what's shown comes within `margin` of the viewport. Mounting thousands of cards at once is what makes
 * long grids slow to open and scroll on phones.
 *
 * Put `sentinel` on an element after the list. Starts over when `resetKey` changes (a new sort, say).
 */
export function useIncremental<T>(items: T[] | undefined, { first = 48, step = 48, margin = '1500px', resetKey }: {
  first?: number;
  step?: number;
  margin?: string;
  resetKey?: unknown;
} = {}) {
  const [count, setCount] = useState(first);
  const observer = useRef<IntersectionObserver | null>(null);
  const total = items?.length ?? 0;

  useEffect(() => setCount(first), [resetKey, first]);

  const sentinel = useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!node || typeof IntersectionObserver === 'undefined') return;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) setCount((c) => Math.min(total, c + step));
        },
        { rootMargin: margin },
      );
      observer.current.observe(node);
    },
    [total, step, margin],
  );

  useEffect(() => () => observer.current?.disconnect(), []);

  // Without IntersectionObserver (old browsers, some test DOMs), show everything.
  const all = typeof IntersectionObserver === 'undefined';
  return { visible: all ? (items ?? []) : (items ?? []).slice(0, count), more: !all && count < total, sentinel };
}

/**
 * Ask for more of a long list (the server's next page) whenever the end of the `count` items shown comes within
 * `margin` of the viewport, while there's `more` to have. Put `sentinel` on an element after the list; it looks
 * again after each batch arrives, so a tall screen keeps asking until it's full.
 */
export function useLoadMore({ count, more, load, margin = '1500px' }: { count: number; more: boolean; load: () => void; margin?: string }) {
  const observer = useRef<IntersectionObserver | null>(null);
  const latest = useRef({ more, load });
  latest.current = { more, load };

  const sentinel = useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!node || typeof IntersectionObserver === 'undefined') return;
      observer.current = new IntersectionObserver(
        (entries) => {
          if (latest.current.more && entries.some((e) => e.isIntersecting)) latest.current.load();
        },
        { rootMargin: margin },
      );
      observer.current.observe(node);
    },
    // A new observer for each batch (`count`): one that saw the end in view already wouldn't say so again.
    [count, more, margin],
  );

  useEffect(() => () => observer.current?.disconnect(), []);
  // Without IntersectionObserver (old browsers, some test DOMs), everything, a batch at a time.
  useEffect(() => {
    if (more && typeof IntersectionObserver === 'undefined') load();
  }, [count, more, load]);
  return sentinel;
}
