import { Bonjour } from 'bonjour-service';

/** What apps on the home network learn about this server before connecting. */
export interface Advertised {
  id: string;
  version: string;
  name: string;
}

/** A TXT string holds at most 255 bytes, its key and "=" included. */
function fit(key: string, value: string): string {
  // By whole characters, so an emoji isn't cut in half.
  const chars = [...value];
  while (Buffer.byteLength(`${key}=${chars.join('')}`) > 255) chars.pop();
  return chars.join('');
}

/** The TXT record of `_playarr._tcp`: which server (id), its version, its name, and where the API is. */
export function txtRecord(info: Advertised): { id: string; v: string; name: string; path: string } {
  return { id: info.id, v: info.version, name: fit('name', info.name), path: '/' };
}

/**
 * Advertise this server as `_playarr._tcp` on the home network, so the iOS app lists it. Works for
 * native installs and host-network Docker; elsewhere the app takes an address. Never throws: a network
 * without multicast just means apps type the address.
 */
export function advertise(opts: {
  port: number;
  info: Advertised;
  log: { info: (msg: string) => void; warn: (obj: object, msg: string) => void };
}): { stop: () => Promise<void> } {
  let bonjour: Bonjour | undefined;
  try {
    bonjour = new Bonjour({}, (err: unknown) => opts.log.warn({ err }, 'Bonjour stopped advertising this server'));
    const service = bonjour.publish({ name: opts.info.name, type: 'playarr', port: opts.port, txt: txtRecord(opts.info) });
    service.on('error', (err: unknown) => opts.log.warn({ err }, 'Bonjour couldn’t advertise this server'));
    opts.log.info(`Advertised on the home network as “${opts.info.name}” (_playarr._tcp)`);
  } catch (err) {
    opts.log.warn({ err }, 'Bonjour couldn’t start: apps can still connect by address');
  }
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        const running = bonjour;
        if (!running) return resolve();
        running.unpublishAll(() => {
          running.destroy();
          resolve();
        });
      }),
  };
}
