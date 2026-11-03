import { readFileSync } from 'node:fs';

/** Put in by tsup at build time (tsup.config.ts); undefined when run from source (dev, tests). */
declare const __APP_VERSION__: string | undefined;

/** Playarr's version: the repository's package.json version, which every commit raises. */
export const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : readVersion();

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
