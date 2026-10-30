import { beforeEach, describe, expect, it } from 'vitest';
import { ACCENTS, PREFS_KEY, usePrefs } from './prefs';

const defaults = { accent: 'album', motion: 'system', formatBadges: true } as const;
const stored = (state: Record<string, unknown>) =>
  localStorage.setItem(PREFS_KEY, JSON.stringify({ state, version: 1 }));

beforeEach(async () => {
  localStorage.clear();
  usePrefs.setState(defaults);
  await usePrefs.persist.rehydrate();
});

describe('device preferences', () => {
  it('starts with the album art accent, the system motion setting and format badges on', () => {
    expect(usePrefs.getState()).toMatchObject(defaults);
  });

  it('keeps what is set, on this device', () => {
    const { setAccent, setMotion, setFormatBadges } = usePrefs.getState();
    setAccent(ACCENTS[2]);
    setMotion('reduce');
    setFormatBadges(false);
    expect(usePrefs.getState()).toMatchObject({ accent: ACCENTS[2], motion: 'reduce', formatBadges: false });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).state).toEqual({ accent: ACCENTS[2], motion: 'reduce', formatBadges: false });
  });

  it('reads saved preferences back', async () => {
    stored({ accent: '#38bdf8', motion: 'full', formatBadges: false });
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState()).toMatchObject({ accent: '#38bdf8', motion: 'full', formatBadges: false });
  });

  it('falls back to the default for a value it does not know', async () => {
    stored({ accent: 'url(evil)', motion: 'sideways', formatBadges: 'yes' });
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState()).toMatchObject(defaults);
    stored({ accent: '#123456', motion: 'reduce' });
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState()).toMatchObject({ accent: 'album', motion: 'reduce', formatBadges: true });
  });
});
