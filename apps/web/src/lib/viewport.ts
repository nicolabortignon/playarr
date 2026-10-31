import { useEffect, useState, type RefObject } from 'react';

type Listener = (entry: IntersectionObserverEntry) => void;

/** One IntersectionObserver per margin, shared by every element watched with it (hundreds of covers). */
const observers = new Map<string, { io: IntersectionObserver; listeners: Map<Element, Listener> }>();

export const canObserve = () => typeof IntersectionObserver !== 'undefined';

function observe(el: Element, margin: string, listener: Listener): () => void {
  let o = observers.get(margin);
  if (!o) {
    const listeners = new Map<Element, Listener>();
    const io = new IntersectionObserver((entries) => entries.forEach((e) => listeners.get(e.target)?.(e)), { rootMargin: margin });
    observers.set(margin, (o = { io, listeners }));
  }
  const { io, listeners } = o;
  listeners.set(el, listener);
  io.observe(el);
  return () => {
    listeners.delete(el);
    io.unobserve(el);
    // Nothing left to watch with this margin: let the observer go.
    if (!listeners.size) {
      io.disconnect();
      observers.delete(margin);
    }
  };
}

/**
 * Whether the element is within `margin` of the screen ("50% 0px": half a screen above or below).
 * Where IntersectionObserver is missing, everything counts as in view.
 */
export function useInView(ref: RefObject<Element | null>, margin: string, initial = false): boolean {
  const [inView, setInView] = useState(canObserve() ? initial : true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !canObserve()) return;
    return observe(el, margin, (e) => setInView(e.isIntersecting));
  }, [ref, margin]);
  return inView;
}

/**
 * For cards in long grids: `near` turns false once the card is more than `margin` from the screen, so it
 * can drop its content (and its image) and keep just its `height`, measured as it left. Cards start near.
 */
export function useNearScreen(ref: RefObject<HTMLElement | null>, margin = '300% 0px'): { near: boolean; height: number } {
  const [state, setState] = useState({ near: true, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !canObserve()) return;
    return observe(el, margin, (e) =>
      setState((s) => (s.near === e.isIntersecting ? s : { near: e.isIntersecting, height: e.boundingClientRect.height || s.height })),
    );
  }, [ref, margin]);
  return state;
}
