import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Heart, ListPlus, Trash2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu } from './Menu';

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
});
