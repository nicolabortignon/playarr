import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Shuffle } from 'lucide-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './Button';

afterEach(cleanup);

describe('Button', () => {
  it('is a plain button named by its label, which a form only submits when asked to', () => {
    const submit = vi.fn((e: Event) => e.preventDefault());
    const click = vi.fn();
    render(
      <form onSubmit={(e) => submit(e.nativeEvent)}>
        <Button icon={<Shuffle />} onClick={click}>
          Shuffle
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('draws each variant with its role’s color', () => {
    render(
      <>
        <Button variant="primary">Play</Button>
        <Button>Cancel</Button>
        <Button variant="ghost">Later</Button>
        <Button variant="danger">Delete</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Play' }).className).toMatch(/\bbg-accent\b/);
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toMatch(/\bborder\b/);
    expect(screen.getByRole('button', { name: 'Later' }).className).not.toMatch(/\bborder\b|\bbg-accent\b/);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/\bbg-danger\b/);
  });

  it('does nothing while disabled', () => {
    const click = vi.fn();
    render(
      <Button disabled onClick={click}>
        Play
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });

  it('says its verb with an ellipsis while pending, and can’t be pressed again', () => {
    const click = vi.fn();
    const { rerender } = render(
      <Button pending pendingLabel="Requesting…" onClick={click}>
        Request
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Requesting…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
    rerender(
      <Button pending={false} pendingLabel="Requesting…" onClick={click}>
        Request
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('is a link with `to`, and goes there', () => {
    render(
      <MemoryRouter initialEntries={['/albums/1']}>
        <Routes>
          <Route path="/albums/1" element={<Button to="/">Back home</Button>} />
          <Route path="/" element={<p>Home page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Back home' });
    expect(link.getAttribute('href')).toBe('/');
    fireEvent.click(link);
    expect(screen.getByText('Home page')).toBeTruthy();
  });
});

describe('IconButton', () => {
  it('is named by its label, as a button or as a link', () => {
    const click = vi.fn();
    render(
      <MemoryRouter>
        <IconButton label="Close" onClick={click}>
          <svg />
        </IconButton>
        <IconButton to="/settings" label="Settings">
          <svg />
        </IconButton>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(click).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
  });
});
