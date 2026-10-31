import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from '../player/store';
import { watchForUpdates } from './appUpdate';
import { useToasts } from './toast';

function fakeServiceWorker(controller: object | null) {
  const sw = Object.assign(new EventTarget(), { controller, getRegistration: vi.fn(async () => undefined) });
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true });
  return { sw, reload };
}

afterEach(() => {
  vi.useRealTimers();
  usePlayer.setState({ playing: false });
  useToasts.setState({ toasts: [] });
});

describe('watchForUpdates', () => {
  it('reloads into a new version right after opening, when nothing is playing', () => {
    const { sw, reload } = fakeServiceWorker({});
    watchForUpdates(Date.now());
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalled();
  });

  it('offers to reload instead while music plays', () => {
    const { sw, reload } = fakeServiceWorker({});
    usePlayer.setState({ playing: true });
    watchForUpdates(Date.now());
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts[0]).toMatchObject({ message: 'Playarr was updated', action: { label: 'Reload' } });
  });

  it('does nothing on the very first install', () => {
    const { sw, reload } = fakeServiceWorker(null);
    watchForUpdates(Date.now());
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
  });
});
