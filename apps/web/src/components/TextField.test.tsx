import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextField } from './TextField';

afterEach(cleanup);

describe('TextField', () => {
  it('labels its field, says what to type under it, and passes on what’s typed', () => {
    const change = vi.fn();
    render(<TextField label="API key" hint="In Lidarr: Settings → General → Security" onChange={(e) => change(e.target.value)} />);
    const field = screen.getByLabelText('API key') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)!.textContent).toBe('In Lidarr: Settings → General → Security');
    fireEvent.change(field, { target: { value: 'abc' } });
    expect(change).toHaveBeenCalledWith('abc');
  });

  it('keeps a label only screen readers hear, and can label another control instead', () => {
    render(
      <>
        <TextField label="Playlist name" hideLabel placeholder="Playlist name" />
        <TextField label="Root folder">
          <select>
            <option>/music</option>
          </select>
        </TextField>
      </>,
    );
    expect(screen.getByLabelText('Playlist name').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Root folder').tagName).toBe('SELECT');
  });
});
