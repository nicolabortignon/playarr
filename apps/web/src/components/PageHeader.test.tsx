import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button';
import { PageHeader } from './PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('titles the page, with how many it holds beside the title rather than in its name', () => {
    render(<PageHeader title="Albums" count={128} />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Albums');
    expect(screen.getByText('128')).toBeTruthy();
  });

  it('shows no count until it’s known, and keeps a count of 0', () => {
    const { rerender, container } = render(<PageHeader title="Playlists" />);
    expect(container.textContent).toBe('Playlists');
    rerender(<PageHeader title="Playlists" count={0} />);
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('holds the page’s own controls, a kicker and a line saying what the page is for', () => {
    render(
      <PageHeader
        title="Requests"
        kicker="Library"
        description="Albums you asked Lidarr to find."
        actions={<Button>Tune your mixes</Button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Tune your mixes' })).toBeTruthy();
    expect(screen.getByText('Library')).toBeTruthy();
    expect(screen.getByText('Albums you asked Lidarr to find.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Requests');
  });
});
