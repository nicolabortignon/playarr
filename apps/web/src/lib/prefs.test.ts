import { beforeEach, describe, expect, it } from 'vitest';
import { ACCENTS, PREFS_KEY, usePrefs } from './prefs';

const defaults = { accent: 'album', motion: 'system', formatBadges: true, recordPlays: true, autoplay: true, transitions: 'off', crossfade: 0, levelVolume: true, profileId: null } as const;
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
    const { setAccent, setMotion, setFormatBadges, setRecordPlays, setAutoplay, setCrossfade, setLevelVolume, setProfileId } = usePrefs.getState();
    setAccent(ACCENTS[2]);
    setMotion('reduce');
    setFormatBadges(false);
    setRecordPlays(false);
    setAutoplay(false);
    usePrefs.getState().setTransitions('dj');
    setCrossfade(6);
    setLevelVolume(false);
    setProfileId(2);
    const saved = { accent: ACCENTS[2], motion: 'reduce', formatBadges: false, recordPlays: false, autoplay: false, transitions: 'dj', crossfade: 6, levelVolume: false, profileId: 2 };
    expect(usePrefs.getState()).toMatchObject(saved);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).state).toEqual(saved);
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

  describe('transitions', () => {
    it('carries on crossfading for someone who had a crossfade before transitions existed', async () => {
      stored({ crossfade: 6 });
      await usePrefs.persist.rehydrate();
      expect(usePrefs.getState()).toMatchObject({ transitions: 'crossfade', crossfade: 6 });
    });

    it('stays gapless for someone who had no crossfade', async () => {
      stored({ crossfade: 0 });
      await usePrefs.persist.rehydrate();
      expect(usePrefs.getState()).toMatchObject({ transitions: 'off', crossfade: 0 });
    });

    it('reads a saved choice back, and ignores one it does not know', async () => {
      stored({ transitions: 'dj', crossfade: 3 });
      await usePrefs.persist.rehydrate();
      expect(usePrefs.getState()).toMatchObject({ transitions: 'dj', crossfade: 3 });
      stored({ transitions: 'scratch' });
      await usePrefs.persist.rehydrate();
      expect(usePrefs.getState().transitions).toBe('off');
    });

    it('gives Crossfade a length when none was picked, so choosing it does something', () => {
      usePrefs.getState().setTransitions('crossfade');
      expect(usePrefs.getState()).toMatchObject({ transitions: 'crossfade', crossfade: 6 });
    });

    it('keeps the length already picked', () => {
      usePrefs.getState().setCrossfade(12);
      usePrefs.getState().setTransitions('off');
      usePrefs.getState().setTransitions('crossfade');
      expect(usePrefs.getState()).toMatchObject({ transitions: 'crossfade', crossfade: 12 });
    });
  });
});
