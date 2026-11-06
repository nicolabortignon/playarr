import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Heart, ListPlus, Trash } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIVIDER, Menu } from './Menu';

afterEach(cleanup);

const item = (label: string, onSelect = () => {}) => ({ label, icon: ListPlus, onSelect });
const more = () => screen.getByRole('button', { name: 'More for “Teardrop”' });

/** Enter on the ⋯ as a keyboard does it: the key goes down, and the button clicks with no pointer behind it. */
const pressEnter = (button: HTMLElement) => {
  fireEvent.keyDown(button, { key: 'Enter' });
  fireEvent.click(button, { detail: 0 });
};

describe('Menu', () => {
  it('is named for what it’s about', () => {
    render(<Menu label="More for “Teardrop”" items={[item('Play next')]} />);
    expect(more().getAttribute('aria-haspopup')).toBe('menu');
  });

  it('moves between items with the arrow keys and gives focus back to its button on close', () => {
    const remove = vi.fn();
    render(<Menu label="More for “Teardrop”" items={[item('Play next'), { label: 'Favorite', icon: Heart, onSelect: () => {} }, { label: 'Remove', icon: Trash, onSelect: remove }]} />);
    const button = more();
    pressEnter(button);
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play next' }));
    fireEvent.keyDown(menu, { key: 'ArrowUp' }); // wraps to the last
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Remove' }));
    fireEvent.keyDown(menu, { key: 'Home' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Favorite' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('draws a line before the place’s own actions, and none where a group is empty', () => {
    render(<Menu label="More for “Teardrop”" items={[DIVIDER, item('Play next'), DIVIDER, DIVIDER, item('Remove'), DIVIDER]} />);
    fireEvent.click(more());
    const kinds = [...screen.getByRole('menu').children].map((c) => c.getAttribute('role'));
    expect(kinds).toEqual(['menuitem', 'separator', 'menuitem']);
  });
});

describe('Where a menu puts the focus', () => {
  it('opened from the keyboard, Enter or Space on ⋯, on its first item', () => {
    render(<Menu label="More for “Teardrop”" items={[item('Play next'), item('Add to queue')]} />);
    pressEnter(more());
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play next' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    // Space clicks when it comes up, after going down on the button.
    fireEvent.keyDown(more(), { key: ' ' });
    fireEvent.keyUp(more(), { key: ' ' });
    fireEvent.click(more(), { detail: 0 });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play next' }));
  });

  it('opened by a tap or a click, on the menu itself: no focus ring round its first item, the arrows still reach it', () => {
    render(<Menu label="More for “Teardrop”" items={[item('Play next')]} />);
    fireEvent.pointerDown(more(), { pointerType: 'touch' });
    fireEvent.click(more(), { detail: 1 });
    expect(document.activeElement).toBe(screen.getByRole('menu'));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play next' }));
  });

  it('opened by a click with neither a pointer nor a key behind it (a script, an assistive tool), on the menu itself', () => {
    render(<Menu label="More for “Teardrop”" items={[item('Play next')]} />);
    fireEvent.click(more(), { detail: 0 });
    expect(document.activeElement).toBe(screen.getByRole('menu'));
  });

  it('opened by a pointer after a key was pressed on ⋯, on the menu itself', () => {
    render(<Menu label="More for “Teardrop”" items={[item('Play next')]} />);
    fireEvent.keyDown(more(), { key: 'Enter' });
    fireEvent.pointerDown(more(), { pointerType: 'mouse' });
    fireEvent.click(more(), { detail: 1 });
    expect(document.activeElement).toBe(screen.getByRole('menu'));
  });
});
