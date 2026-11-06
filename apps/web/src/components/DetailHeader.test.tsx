import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button';
import { DetailHeader, joinMeta } from './DetailHeader';

afterEach(cleanup);

/** Whether `a` comes before `b` in the document: the order a screen reader reads them in. */
const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('DetailHeader', () => {
  it('reads cover, kicker, title, meta line, then the action row', () => {
    render(
      <DetailHeader
        cover={<img alt="Mezzanine cover" />}
        kicker="Album"
        title="Mezzanine"
        meta={joinMeta('1998', '11 songs', '63 min')}
      >
        <Button variant="primary">Play</Button>
      </DetailHeader>,
    );
    const cover = screen.getByRole('img', { name: 'Mezzanine cover' });
    const kicker = screen.getByText('Album');
    const title = screen.getByRole('heading', { level: 1, name: 'Mezzanine' });
    const meta = screen.getByText('11 songs');
    const play = screen.getByRole('button', { name: 'Play' });
    expect(before(cover, kicker)).toBe(true);
    expect(before(kicker, title)).toBe(true);
    expect(before(title, meta)).toBe(true);
    expect(before(meta, play)).toBe(true);
  });

  it('puts something else in the title’s place while it’s being edited', () => {
    render(<DetailHeader kicker="Playlist" title="Road trip" heading={<input aria-label="Playlist name" defaultValue="Road trip" />} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Playlist name' })).toBeTruthy();
  });
});

describe('joinMeta', () => {
  it('sets a dot between the parts and leaves out the missing ones', () => {
    render(<p>{joinMeta('Massive Attack', undefined, 1998, false, '', '11 songs')}</p>);
    expect(screen.getByRole('paragraph').textContent).toBe('Massive Attack·1998·11 songs');
  });
});
