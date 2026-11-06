import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUI } from '../lib/ui';
import { useKeyboardShortcuts } from '../player/useKeyboardShortcuts';
import { ShortcutsOverlay } from './Shortcuts';

/** What AppShell mounts for the keyboard: the shortcuts, and their overlay. */
function Keyboard() {
  useKeyboardShortcuts();
  return (
    <>
      <input aria-label="A field" />
      <ShortcutsOverlay />
    </>
  );
}

const press = (target: Element, key: string) => act(() => void fireEvent.keyDown(target, { key, bubbles: true }));
const overlay = () => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' });

beforeEach(() => {
  useUI.setState({ shortcutsOpen: false });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Keyboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
});
afterEach(cleanup);

describe('the ? overlay', () => {
  it('opens on ? and lists the shortcuts as a sleeve does, side A then side B, numbered', () => {
    press(document.body, '?');
    const sheet = overlay()!;
    expect(within(sheet).getByRole('heading', { name: 'Side A · Playing' })).toBeTruthy();
    expect(within(sheet).getByRole('heading', { name: 'Side B · Getting around' })).toBeTruthy();
    const first = within(sheet).getAllByRole('listitem')[0]!;
    expect(first.textContent).toBe('A1Play or pauseSpace');
  });

  it('closes on Escape, and on ? again', async () => {
    press(document.body, '?');
    press(document.body, 'Escape');
    expect(useUI.getState().shortcutsOpen).toBe(false);
    await waitFor(() => expect(overlay()).toBeNull());
    press(document.body, '?');
    expect(overlay()).not.toBeNull();
    press(document.body, '?');
    expect(useUI.getState().shortcutsOpen).toBe(false);
    await waitFor(() => expect(overlay()).toBeNull());
  });

  it('doesn’t open while typing in a field', () => {
    press(screen.getByRole('textbox', { name: 'A field' }), '?');
    expect(overlay()).toBeNull();
  });
});
