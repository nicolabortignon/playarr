import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Choice } from './Choice';

afterEach(cleanup);

const SORTS = [
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year', disabled: true, title: 'Not on this device' },
  { value: 'added', label: 'Recently added' },
] as const;

type Sort = (typeof SORTS)[number]['value'];

/** A Choice that keeps what's chosen, as its pages do. */
function Sorts({ onChange, disabled }: { onChange?: (v: Sort) => void; disabled?: boolean }) {
  const [value, setValue] = useState<Sort>('artist');
  return (
    <Choice
      label="Sort albums"
      options={SORTS}
      value={value}
      disabled={disabled}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const group = () => within(screen.getByRole('radiogroup', { name: 'Sort albums' }));
const checked = () => group().getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);

describe('Choice', () => {
  it('is a named group of radios with one chosen, the only one in the tab order', () => {
    render(<Sorts />);
    expect(group().getAllByRole('radio').map((r) => r.textContent)).toEqual(['Artist', 'Title', 'Year', 'Recently added']);
    expect(checked()).toEqual(['Artist']);
    expect(group().getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('chooses what’s tapped', () => {
    const change = vi.fn();
    render(<Sorts onChange={change} />);
    fireEvent.click(group().getByRole('radio', { name: 'Recently added' }));
    expect(change).toHaveBeenCalledWith('added');
    expect(checked()).toEqual(['Recently added']);
    expect(group().getByRole('radio', { name: 'Recently added' }).tabIndex).toBe(0);
  });

  it('moves and chooses with the arrow keys, Home and End, stepping over what can’t be chosen', () => {
    render(<Sorts />);
    const radios = group().getAllByRole('radio');
    const groupEl = screen.getByRole('radiogroup');
    radios[0]!.focus();
    fireEvent.keyDown(groupEl, { key: 'ArrowRight' });
    expect(checked()).toEqual(['Title']);
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(groupEl, { key: 'ArrowRight' }); // over Year, which this device can't do
    expect(checked()).toEqual(['Recently added']);
    expect(document.activeElement).toBe(radios[3]);
    fireEvent.keyDown(groupEl, { key: 'ArrowRight' }); // round to the start
    expect(checked()).toEqual(['Artist']);
    fireEvent.keyDown(groupEl, { key: 'End' });
    expect(checked()).toEqual(['Recently added']);
    fireEvent.keyDown(groupEl, { key: 'Home' });
    expect(checked()).toEqual(['Artist']);
    expect((radios[2] as HTMLButtonElement).disabled).toBe(true);
    expect(radios[2]!.title).toBe('Not on this device');
  });

  it('lets nothing be chosen while the whole group is disabled', () => {
    const change = vi.fn();
    render(<Sorts onChange={change} disabled />);
    expect(screen.getByRole('radiogroup').getAttribute('aria-disabled')).toBe('true');
    for (const radio of group().getAllByRole('radio')) expect((radio as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(change).not.toHaveBeenCalled();
    expect(checked()).toEqual(['Artist']);
  });
});
