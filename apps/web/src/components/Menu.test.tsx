import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Heart, ListPlus, Trash2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIVIDER, Menu } from './Menu';

afterEach(cleanup);

describe('Menu', () => {
  it('moves between items with the arrow keys and gives focus back to its button on close', () => {
    const remove = vi.fn();
    render(
      <Menu
        items={[
          { label: 'Play next', icon: ListPlus, onSelect: () => {} },
          { label: 'Favorite', icon: Heart, onSelect: () => {} },
          { label: 'Remove', icon: Trash2, onSelect: remove },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play next' }));
    fireEvent.keyDown(menu, { key: 'ArrowUp' }); // wraps to the last
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Remove' }));
    fireEvent.keyDown(menu, { key: 'Home' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Favorite' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('draws a line before the place’s own actions, and none where a group is empty', () => {
    const item = (label: string) => ({ label, icon: ListPlus, onSelect: () => {} });
    render(<Menu items={[DIVIDER, item('Play next'), DIVIDER, DIVIDER, item('Remove'), DIVIDER]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const kinds = [...screen.getByRole('menu').children].map((c) => c.getAttribute('role'));
    expect(kinds).toEqual(['menuitem', 'separator', 'menuitem']);
  });

  it('opened by a pointer, focuses the menu rather than its first item; Escape closes it alone', () => {
    const escapes = vi.fn();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && escapes();
    window.addEventListener('keydown', onKey);
    render(<Menu items={[{ label: 'Play next', icon: ListPlus, onSelect: () => {} }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }), { detail: 1 });
    expect(document.activeElement).toBe(screen.getByRole('menu'));
    // Arrows still reach the items.
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play next' }));
    // A sheet or a dialog under it, listening on the window, doesn't close as well.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(escapes).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onKey);
  });
});
