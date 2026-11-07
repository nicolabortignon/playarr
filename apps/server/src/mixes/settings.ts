import type { MixKind, MixSettings } from '@playarr/shared';
import type { CatalogStore } from '../catalog/store.ts';
import { validTimeZone } from './time.ts';

export const MIXES_KEY = 'mixes';

export const MIX_KINDS: MixKind[] = [
  'vibes',
  'discovery',
  'repeat',
  'blast',
  'deepcuts',
  'fresh',
  'decade',
  'genre',
  'energy',
  'chill',
  'winddown',
  'focus',
  'onthisday',
];

export const MIX_DEFAULTS: MixSettings = {
  enabled: {},
  length: 50,
  adventurous: 0.5,
  blastDays: 90,
  genreMixes: 3,
  decadeMixes: 2,
  recordHistory: true,
  analyzeLibrary: false,
};

const LENGTHS = [25, 50, 75, 100] as const;
const BLAST_DAYS = [30, 90, 180, 365] as const;

/** Settings → Mixes, as stored (anything missing or damaged reads as the default). */
export function readMixSettings(store: Pick<CatalogStore, 'appSetting'>): MixSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(store.appSetting(MIXES_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // defaults
  }
  const enabled: MixSettings['enabled'] = {};
  if (raw.enabled && typeof raw.enabled === 'object') {
    for (const kind of MIX_KINDS) {
      const v = (raw.enabled as Record<string, unknown>)[kind];
      if (typeof v === 'boolean') enabled[kind] = v;
    }
  }
  const count = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4 ? v : fallback);
  return {
    enabled,
    length: LENGTHS.find((l) => l === raw.length) ?? MIX_DEFAULTS.length,
    adventurous: typeof raw.adventurous === 'number' && raw.adventurous >= 0 && raw.adventurous <= 1 ? raw.adventurous : MIX_DEFAULTS.adventurous,
    blastDays: BLAST_DAYS.find((d) => d === raw.blastDays) ?? MIX_DEFAULTS.blastDays,
    genreMixes: count(raw.genreMixes, MIX_DEFAULTS.genreMixes),
    decadeMixes: count(raw.decadeMixes, MIX_DEFAULTS.decadeMixes),
    recordHistory: typeof raw.recordHistory === 'boolean' ? raw.recordHistory : MIX_DEFAULTS.recordHistory,
    analyzeLibrary: typeof raw.analyzeLibrary === 'boolean' ? raw.analyzeLibrary : MIX_DEFAULTS.analyzeLibrary,
    ...(typeof raw.timeZone === 'string' && validTimeZone(raw.timeZone) ? { timeZone: raw.timeZone } : {}),
  };
}

export const isEnabled = (settings: MixSettings, kind: MixKind) => settings.enabled[kind] !== false;
