import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePrefs } from '../lib/prefs';
import { PlaybackPanel } from './PlaybackPanel';

const view = () =>
  render(
    <MemoryRouter>
      <PlaybackPanel />
    </MemoryRouter>,
  );

const transitions = () => within(screen.getByRole('radiogroup', { name: 'Transitions' }));
const lengths = () => screen.queryByRole('radiogroup', { name: 'Crossfade length' });

beforeEach(() => usePrefs.setState({ transitions: 'off', crossfade: 0 }));
afterEach(cleanup);

describe('PlaybackPanel transitions', () => {
  it('offers crossfade lengths only once Crossfade is chosen', () => {
    view();
    expect(transitions().getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
    expect(lengths()).toBeNull();
    fireEvent.click(transitions().getByRole('radio', { name: 'Crossfade' }));
    expect(usePrefs.getState()).toMatchObject({ transitions: 'crossfade', crossfade: 6 });
    expect(lengths()).not.toBeNull();
    expect(screen.getByRole('radio', { name: '6 s' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(transitions().getByRole('radio', { name: 'DJ mix' }));
    expect(usePrefs.getState().transitions).toBe('dj');
    expect(lengths()).toBeNull();
    expect(screen.getByText(/mixed like a DJ would/)).toBeTruthy();
  });
});
