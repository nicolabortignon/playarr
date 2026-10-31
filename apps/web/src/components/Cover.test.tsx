import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_LOADING, resetImageQueue } from '../lib/imageQueue';
import { Cover } from './Cover';

/** A controllable IntersectionObserver per margin: `show(el, margin)` says the element came that close. */
let observers: { margin: string; callback: IntersectionObserverCallback; nodes: Set<Element> }[] = [];
const report = (el: Element, margins: string[]) => {
  for (const o of observers) {
    if (!o.nodes.has(el)) continue;
    const entry = { target: el, isIntersecting: margins.includes(o.margin), boundingClientRect: { height: 200 } };
    o.callback([entry as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  }
};
/** Elements come near the screen together, as one scroll reports them. */
const show = (els: Element[], margins: (el: Element) => string[]) =>
  act(async () => {
    for (const el of els) report(el, margins(el));
  });

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private o: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
        this.o = { margin: opts?.rootMargin ?? '', callback, nodes: new Set() };
        observers.push(this.o);
      }
      observe(el: Element) {
        this.o.nodes.add(el);
      }
      unobserve(el: Element) {
        this.o.nodes.delete(el);
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  resetImageQueue();
  vi.unstubAllGlobals();
});

const covers = (n: number) =>
  render(
    <>
      {Array.from({ length: n }, (_, i) => (
        <Cover key={i} src={`/art/album/${i}/cover`} size={100} alt={`Album ${i}`} />
      ))}
    </>,
  );

describe('Cover', () => {
  it('loads nothing until near the screen, then a few at a time, those on screen first', async () => {
    const { container } = covers(MAX_LOADING + 2);
    const boxes = [...container.querySelectorAll('div.aspect-square')];
    expect(container.querySelectorAll('img')).toHaveLength(0);
    // All of them come within reach; the last one is actually on screen.
    await show(boxes, (box) => (box === boxes.at(-1) ? ['50% 0px', '0px'] : ['50% 0px']));
    const imgs = () => [...container.querySelectorAll('img')].map((i) => i.alt);
    expect(imgs()).toHaveLength(MAX_LOADING);
    expect(imgs()).toContain(`Album ${MAX_LOADING + 1}`);
    fireEvent.load(container.querySelector('img')!);
    await act(async () => {});
    expect(imgs()).toHaveLength(MAX_LOADING + 1);
  });

  it('shows an image loaded before at once, without waiting for a turn', async () => {
    const first = render(<Cover src="/art/album/1/cover" size={100} alt="Again" />);
    const box = first.container.querySelector('div.aspect-square')!;
    await show([box], () => ['50% 0px', '0px']);
    fireEvent.load(first.container.querySelector('img')!);
    first.unmount();
    const again = render(<Cover src="/art/album/1/cover" size={100} alt="Again" />);
    expect(again.container.querySelector('img')).not.toBeNull();
  });
});
