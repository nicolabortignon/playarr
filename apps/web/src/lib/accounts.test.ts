import type { Account } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS_KEY, deviceName, remember, signedIn, switchTo, useAccounts } from './accounts';
import { api, ApiError } from './api';
import { queryClient } from './queryClient';

const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAccounts.setState({ accounts: [] });
  queryClient.clear();
});

describe('accounts on this device', () => {
  it('keeps each signed-in account’s token, and makes it the session cookie', async () => {
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    await signedIn({ token: 'tok-2', account: SAM });
    expect(JSON.parse(localStorage.getItem(ACCOUNTS_KEY)!)).toEqual([{ accountId: 2, name: 'Sam', username: 'sam', token: 'tok-2' }]);
    expect(swap).toHaveBeenCalledWith('tok-2');
    // Signing in again replaces the old token rather than adding a second entry.
    await signedIn({ token: 'tok-3', account: SAM });
    expect(useAccounts.getState().accounts).toEqual([{ accountId: 2, name: 'Sam', username: 'sam', token: 'tok-3' }]);
  });

  it('forgets an account whose sign-in has ended', async () => {
    remember({ token: 'old', account: SAM });
    vi.spyOn(api, 'switchAccount').mockRejectedValue(new ApiError('That sign-in has ended: sign in again', 401));
    await expect(switchTo(2)).rejects.toThrow('That sign-in has ended');
    expect(useAccounts.getState().accounts).toEqual([]);
    expect(localStorage.getItem(ACCOUNTS_KEY)).toBe('[]');
  });

  it('reads back what an earlier visit kept, ignoring anything malformed', async () => {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([{ accountId: 2, name: 'Sam', username: 'sam', token: 't' }, { accountId: 'x' }, 'junk']));
    vi.resetModules();
    const fresh = await import('./accounts');
    expect(fresh.useAccounts.getState().accounts).toEqual([{ accountId: 2, name: 'Sam', username: 'sam', token: 't' }]);
  });

  it('names the device from its browser', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe('Chrome on Mac');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on Windows');
    expect(deviceName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toBe('Edge on Linux');
  });
});
