// The App Store listing of the iOS app, offline: the text in store/en-US, the settings in store/app.json and
// the screenshots in store/screenshots, read and checked against Apple's limits. Also the pure pieces that
// release.mjs needs to bring App Store Connect in line with them: what changed, which version to edit, which
// screenshots to upload, and the request bodies. Nothing here talks to Apple; appstore.mjs does.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORE = fileURLToPath(new URL('../store', import.meta.url));
export const LOCALE = 'en-US';

/** Each text file in store/en-US: the App Store Connect attribute it fills, where that lives, and Apple's limit. */
export const FIELDS = [
  { file: 'name.txt', key: 'name', on: 'appInfoLocalization', max: 30, required: true },
  { file: 'subtitle.txt', key: 'subtitle', on: 'appInfoLocalization', max: 30 },
  { file: 'privacy-policy-url.txt', key: 'privacyPolicyUrl', on: 'appInfoLocalization', url: true, required: true },
  { file: 'description.txt', key: 'description', on: 'versionLocalization', max: 4000, required: true },
  { file: 'keywords.txt', key: 'keywords', on: 'versionLocalization', max: 100, required: true },
  { file: 'promotional-text.txt', key: 'promotionalText', on: 'versionLocalization', max: 170 },
  { file: 'whats-new.txt', key: 'whatsNew', on: 'versionLocalization', max: 4000 },
  { file: 'support-url.txt', key: 'supportUrl', on: 'versionLocalization', url: true, required: true },
  { file: 'marketing-url.txt', key: 'marketingUrl', on: 'versionLocalization', url: true },
  { file: 'review-notes.txt', key: 'notes', on: 'reviewDetail', max: 4000, required: true },
];

/** The only placeholders review-notes.txt may use; release.mjs fills them from the environment. */
export const NOTE_PLACEHOLDERS = ['REVIEW_SERVER_URL', 'REVIEW_USERNAME'];

/** The age rating questionnaire as the API has it (ageRatingDeclarations, API 4.5.1): every one is answered. */
export const AGE_RATING = {
  levels: [
    'alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated', 'gunsOrOtherWeapons', 'horrorOrFearThemes',
    'matureOrSuggestiveThemes', 'medicalOrTreatmentInformation', 'profanityOrCrudeHumor', 'sexualContentGraphicAndNudity',
    'sexualContentOrNudity', 'violenceCartoonOrFantasy', 'violenceRealistic', 'violenceRealisticProlongedGraphicOrSadistic',
  ],
  booleans: [
    'advertising', 'ageAssurance', 'gambling', 'healthOrWellnessTopics', 'lootBox', 'messagingAndChat', 'parentalControls',
    'socialMedia', 'unrestrictedWebAccess', 'userGeneratedContent',
  ],
  values: ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE'],
};

export const CONTENT_RIGHTS = ['DOES_NOT_USE_THIRD_PARTY_CONTENT', 'USES_THIRD_PARTY_CONTENT'];
export const RELEASE_TYPES = ['AFTER_APPROVAL', 'MANUAL'];

/** The listing: text by attribute (null when a file is missing or empty) and app.json. */
export function readStore(dir = STORE, locale = LOCALE) {
  const text = {};
  for (const { file, key } of FIELDS) {
    const path = join(dir, locale, file);
    const value = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim() : '';
    text[key] = value || null;
  }
  const appPath = join(dir, 'app.json');
  const app = existsSync(appPath) ? JSON.parse(readFileSync(appPath, 'utf8')) : null;
  return { locale, text, app };
}

const length = (s) => [...s].length;

/** Everything wrong with the listing, as sentences; empty when it can be sent. */
export function validateStore({ text, app }) {
  const problems = [];
  for (const { file, key, max, url, required } of FIELDS) {
    const value = text[key];
    if (value == null) {
      if (required) problems.push(`${file} is missing or empty`);
      continue;
    }
    if (max && length(value) > max) problems.push(`${file} has ${length(value)} characters; Apple allows ${max}`);
    if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(value)) problems.push(`${file} must be one https:// address`);
    const placeholders = [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const allowed = key === 'notes' ? NOTE_PLACEHOLDERS : [];
    for (const name of placeholders.filter((p) => !allowed.includes(p))) problems.push(`${file} still has {{${name}}}`);
  }
  if (text.keywords != null) {
    const words = text.keywords.split(',');
    if (words.some((w) => w !== w.trim())) problems.push('keywords.txt: no spaces around the commas (they count against the 100)');
    if (words.some((w) => !w.trim())) problems.push('keywords.txt has an empty keyword');
    const lower = words.map((w) => w.trim().toLowerCase());
    if (new Set(lower).size !== lower.length) problems.push('keywords.txt repeats a keyword');
    if (text.name && lower.includes(text.name.toLowerCase())) problems.push('keywords.txt repeats the app name, which is searched anyway');
  }
  if (!app) return [...problems, 'app.json is missing'];
  if (!app.copyright?.trim()) problems.push('app.json: copyright is missing');
  if (app.primaryCategory !== 'MUSIC') problems.push('app.json: primaryCategory should be MUSIC');
  if (!CONTENT_RIGHTS.includes(app.contentRights)) problems.push(`app.json: contentRights must be one of ${CONTENT_RIGHTS.join(', ')}`);
  if (!RELEASE_TYPES.includes(app.releaseType)) problems.push(`app.json: releaseType must be one of ${RELEASE_TYPES.join(', ')}`);
  if (app.price !== 'free') problems.push('app.json: price must be "free" (release.mjs sets no other price)');
  if (typeof app.availableInNewTerritories !== 'boolean') problems.push('app.json: availableInNewTerritories must be true or false');
  const rating = app.ageRating ?? {};
  for (const key of AGE_RATING.levels) {
    if (!AGE_RATING.values.includes(rating[key])) problems.push(`app.json: ageRating.${key} must be one of ${AGE_RATING.values.join(', ')}`);
  }
  for (const key of AGE_RATING.booleans) {
    if (typeof rating[key] !== 'boolean') problems.push(`app.json: ageRating.${key} must be true or false`);
  }
  const known = new Set([...AGE_RATING.levels, ...AGE_RATING.booleans]);
  for (const key of Object.keys(rating).filter((k) => !known.has(k))) problems.push(`app.json: ageRating.${key} isn't a question App Store Connect asks`);
  return problems;
}

/** review-notes.txt with {{REVIEW_SERVER_URL}} and {{REVIEW_USERNAME}} filled in; throws naming what's unset. */
export function fillNotes(template, env) {
  const missing = NOTE_PLACEHOLDERS.filter((name) => template.includes(`{{${name}}}`) && !env[name]);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} (in .env, or the GitHub secrets in CI)`);
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => env[name]);
}

/**
 * Screenshot folders → App Store Connect display types and the sizes Apple accepts (portrait; landscape is the
 * same sizes turned). iPhone 6.9" ("Dynamic Island, large display") and iPad 13" are what the App Store needs;
 * the 6.3" set is optional, sent when its folder exists.
 */
export const SCREENSHOT_SETS = {
  'iphone-6.9': { displayType: 'APP_IPHONE_67', simulator: 'iPhone 17 Pro Max', required: true, sizes: [[1320, 2868], [1290, 2796], [1260, 2736]] },
  'iphone-6.3': { displayType: 'APP_IPHONE_61', simulator: 'iPhone 17 Pro', required: false, sizes: [[1206, 2622], [1179, 2556]] },
  'ipad-13': { displayType: 'APP_IPAD_PRO_3GEN_129', simulator: 'iPad Pro 13-inch (M5)', required: true, sizes: [[2064, 2752], [2048, 2732]] },
};
export const MAX_SCREENSHOTS = 10;

/** Width, height and whether a PNG has transparency (an alpha channel or a tRNS chunk). Throws for non-PNGs. */
export function pngInfo(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  let alpha = colorType === 4 || colorType === 6;
  for (let at = 8; at + 8 <= buffer.length; ) {
    const size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + size;
  }
  return { width, height, alpha };
}

export const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

/** The screenshot folders that exist, each with its PNGs in file-name order. */
export function readScreenshots(dir = join(STORE, 'screenshots')) {
  const sets = [];
  for (const [folder, spec] of Object.entries(SCREENSHOT_SETS)) {
    const path = join(dir, folder);
    if (!existsSync(path)) continue;
    const files = readdirSync(path)
      .filter((name) => name.endsWith('.png'))
      .sort()
      .map((name) => {
        const buffer = readFileSync(join(path, name));
        let info;
        try {
          info = pngInfo(buffer);
        } catch {
          info = { width: 0, height: 0, alpha: false, broken: true };
        }
        return { name, path: join(path, name), size: buffer.length, md5: md5(buffer), ...info };
      });
    sets.push({ folder, ...spec, files });
  }
  return sets;
}

/** Everything wrong with the screenshots, as sentences. */
export function validateScreenshots(sets) {
  const problems = [];
  for (const [folder, spec] of Object.entries(SCREENSHOT_SETS)) {
    if (spec.required && !sets.some((s) => s.folder === folder && s.files.length)) {
      problems.push(`screenshots/${folder} has no screenshots (make screenshots takes them on the ${spec.simulator} simulator)`);
    }
  }
  for (const set of sets) {
    if (set.files.length > MAX_SCREENSHOTS) problems.push(`screenshots/${set.folder} has ${set.files.length} screenshots; Apple takes ${MAX_SCREENSHOTS}`);
    for (const file of set.files) {
      const where = `screenshots/${set.folder}/${file.name}`;
      if (!/^\d\d-[a-z0-9-]+\.png$/.test(file.name)) problems.push(`${where}: name it NN-what-it-shows.png`);
      if (file.broken) {
        problems.push(`${where} isn't a PNG`);
        continue;
      }
      const fits = set.sizes.some(([w, h]) => (file.width === w && file.height === h) || (file.width === h && file.height === w));
      if (!fits) problems.push(`${where} is ${file.width}×${file.height}; ${set.displayType} takes ${set.sizes.map(([w, h]) => `${w}×${h}`).join(', ')} (or turned)`);
      if (file.alpha) problems.push(`${where} has transparency, which App Store Connect refuses (scripts/flatten-png.swift removes it)`);
    }
  }
  return problems;
}
