import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIncremental } from './useIncremental';

/** A controllable IntersectionObserver: `reveal()` says the sentinel came into view. */
let observed: { callback: IntersectionObserverCallback; node?: Element }[] = [];
const reveal = () =>
  act(() => {
    const last = observed.at(-1)!;
    last.callback([{ isIntersecting: true, target: last.node! } as IntersectionObserverEntry], {} as IntersectionObserver);
  });

beforeEach(() => {
  observed = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private entry: { callback: IntersectionObserverCallback; node?: Element };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback };
        observed.push(this.entry);
      }
      observe(node: Element) {
        this.entry.node = node;
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function List({ items, sort }: { items: number[]; sort: string }) {
  const { visible, more, sentinel } = useIncremental(items, { first: 3, step: 2, resetKey: sort });
  return (
    <>
      <p data-testid="shown">{visible.join(',')}</p>
      {more && <div ref={sentinel} />}
    </>
  );
}

describe('useIncremental', () => {
  it('shows a first batch, adds more as the end comes into view, and starts over on a new sort', () => {
    const items = [1, 2, 3, 4, 5, 6];
    const { rerender } = render(<List items={items} sort="artist" />);
    expect(screen.getByTestId('shown').textContent).toBe('1,2,3');
    reveal();
    expect(screen.getByTestId('shown').textContent).toBe('1,2,3,4,5');
    reveal();
    expect(screen.getByTestId('shown').textContent).toBe('1,2,3,4,5,6');
    rerender(<List items={[6, 5, 4, 3, 2, 1]} sort="year" />);
    expect(screen.getByTestId('shown').textContent).toBe('6,5,4');
  });

  it('shows everything where IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<List items={[1, 2, 3, 4, 5]} sort="artist" />);
    expect(screen.getByTestId('shown').textContent).toBe('1,2,3,4,5');
  });
});
