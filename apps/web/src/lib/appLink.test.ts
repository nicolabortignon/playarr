import { describe, expect, it } from 'vitest';
import { appDeviceLink, appRedeemLink, deviceCodeOf, onIPhoneOrIPad } from './appLink';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

describe('the iOS app link', () => {
  it('knows an iPhone, and an iPad asking for the desktop page by its touch screen', () => {
    expect(onIPhoneOrIPad(IPHONE, 5)).toBe(true);
    expect(onIPhoneOrIPad(MAC, 5)).toBe(true);
    expect(onIPhoneOrIPad(MAC, 0)).toBe(false);
    expect(onIPhoneOrIPad(WINDOWS, 10)).toBe(false);
  });

  it('opens a setup code in the app at the address the page came from', () => {
    expect(appRedeemLink('https://music.example.com', 'K7PQ2MXA')).toBe('playarr://redeem?server=https%3A%2F%2Fmusic.example.com&code=K7PQ2MXA');
    expect(appDeviceLink('http://nas.local:4000', 'ABCD2345')).toBe('playarr://link?server=http%3A%2F%2Fnas.local%3A4000&code=ABCD2345');
  });

  it('reads the TV’s code from where signing in goes next', () => {
    expect(deviceCodeOf('/link?code=ABCD2345')).toBe('ABCD2345');
    expect(deviceCodeOf('/link?code=abcd-2345')).toBe('ABCD2345');
    expect(deviceCodeOf('/link')).toBe('');
    expect(deviceCodeOf('/link?code=ABC')).toBe('');
    expect(deviceCodeOf('/library?code=ABCD2345')).toBe('');
  });
});
