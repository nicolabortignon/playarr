import { describe, expect, it } from 'vitest';
import { txtRecord } from './bonjour.ts';

describe('txtRecord', () => {
  it('advertises the server’s id, version, name and where the API is', () => {
    expect(txtRecord({ id: '2b1c9f0e-1111-4222-8333-444455556666', version: '0.6.175', name: 'NAS' })).toEqual({
      id: '2b1c9f0e-1111-4222-8333-444455556666',
      v: '0.6.175',
      name: 'NAS',
      path: '/',
    });
  });

  it('shortens a name to fit a TXT string (255 bytes with its key)', () => {
    const { name } = txtRecord({ id: 'x', version: '1', name: 'é'.repeat(200) });
    expect(Buffer.byteLength(`name=${name}`)).toBeLessThanOrEqual(255);
    expect(name.startsWith('éééé')).toBe(true);
  });
});
