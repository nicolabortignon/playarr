import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { submitForReview, syncListing, withDryRun } from './appstore.mjs';
import { fillNotes, md5, readStore, reviewDetailAttributes } from './store.mjs';

const APP = '6830169335';
const VERSION = 'v1';
const INFO = 'info1';
const LOC = 'loc1';
const SET = 'set1';
const env = {
  REVIEW_SERVER_URL: 'https://music.example.com', REVIEW_USERNAME: 'reviewer', REVIEW_PASSWORD: 'secret',
  REVIEW_CONTACT_FIRST_NAME: 'Ada', REVIEW_CONTACT_LAST_NAME: 'Lovelace', REVIEW_CONTACT_EMAIL: 'ada@example.com', REVIEW_CONTACT_PHONE: '+44 20 7946 0000',
};
const store = readStore();
const shot = Buffer.from('a screenshot');
const shotPath = join(mkdtempSync(join(tmpdir(), 'playarr-shot-')), '01-home.png');
writeFileSync(shotPath, shot);
const screenshots = [{ folder: 'iphone-6.9', displayType: 'APP_IPHONE_67', files: [{ name: '01-home.png', path: shotPath, size: shot.length, md5: md5(shot) }] }];
const build = { id: 'build330', number: 330 };

/** An App Store Connect that answers the GETs in `routes` (null: 404) and records every write. */
function fakeApi(routes) {
  const writes = [];
  const read = (path) => {
    if (!(path in routes)) throw new Error(`unexpected GET ${path}`);
    return routes[path];
  };
  return {
    writes,
    get: async (path) => {
      const res = read(path);
      if (res === null) throw new Error(`404 for ${path}`);
      return res;
    },
    getOrNull: async (path) => read(path),
    post: async (path, body) => {
      writes.push(['POST', path]);
      if (path === '/v1/appScreenshots') {
        return { data: { type: 'appScreenshots', id: 'shot-new', attributes: { uploadOperations: [{ method: 'PUT', url: 'https://upload.example/1', offset: 0, length: shot.length, requestHeaders: [] }] } } };
      }
      return { data: { ...body.data, id: `new-${body.data.type}` } };
    },
    patch: async (path) => {
      writes.push(['PATCH', path]);
      return {};
    },
    del: async (path) => {
      writes.push(['DELETE', path]);
      return null;
    },
    put: async ({ url, body }) => writes.push(['PUT', url, body.length]),
    sleep: async () => {},
  };
}

/** What App Store Connect held for Playarr on 2026-11-03: the app record and its empty "1.0" version. */
const fresh = {
  [`/v1/apps/${APP}?fields[apps]=contentRightsDeclaration`]: { data: { type: 'apps', id: APP, attributes: { contentRightsDeclaration: null } } },
  [`/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=200`]: {
    data: [{ type: 'appStoreVersions', id: VERSION, attributes: { versionString: '1.0', appVersionState: 'PREPARE_FOR_SUBMISSION', appStoreState: 'PREPARE_FOR_SUBMISSION', copyright: null, releaseType: 'AFTER_APPROVAL' } }],
  },
  [`/v1/appStoreVersions/${VERSION}/appStoreVersionLocalizations`]: { data: [{ type: 'appStoreVersionLocalizations', id: LOC, attributes: { locale: 'en-US', description: null } }] },
  [`/v1/apps/${APP}/appInfos`]: { data: [{ type: 'appInfos', id: INFO, attributes: { state: 'PREPARE_FOR_SUBMISSION' } }] },
  [`/v1/appInfos/${INFO}/appInfoLocalizations`]: { data: [{ type: 'appInfoLocalizations', id: 'infoloc1', attributes: { locale: 'en-US', name: 'Playarr', subtitle: null, privacyPolicyUrl: null } }] },
  [`/v1/appInfos/${INFO}/primaryCategory`]: { data: null },
  [`/v1/appInfos/${INFO}/ageRatingDeclaration`]: { data: { type: 'ageRatingDeclarations', id: INFO, attributes: { profanityOrCrudeHumor: null, ageRatingOverrideV2: 'NONE' } } },
  [`/v1/appPriceSchedules/${APP}/manualPrices?include=appPricePoint&limit=50`]: null,
  [`/v1/apps/${APP}/appPricePoints?filter[territory]=USA&limit=200`]: { data: [{ type: 'appPricePoints', id: 'free-usa', attributes: { customerPrice: '0.0' } }, { type: 'appPricePoints', id: 'paid', attributes: { customerPrice: '0.29' } }] },
  [`/v1/apps/${APP}/appAvailabilityV2`]: null,
  ['/v1/territories?limit=200']: { data: [{ type: 'territories', id: 'GBR' }, { type: 'territories', id: 'USA' }] },
  [`/v1/appStoreVersions/${VERSION}/appStoreReviewDetail`]: { data: null },
  [`/v1/appStoreVersionLocalizations/${LOC}/appScreenshotSets?limit=50`]: { data: [] },
  ['/v1/appScreenshotSets/new-appScreenshotSets/appScreenshots?limit=50']: { data: [] },
  ['/v1/appScreenshots/shot-new?fields[appScreenshots]=assetDeliveryState']: { data: { attributes: { assetDeliveryState: { state: 'COMPLETE' } } } },
  [`/v1/appStoreVersions/${VERSION}/build`]: { data: null },
};

const quiet = () => {};

test('a fresh app record gets everything, the "1.0" version renamed, and the screenshot uploaded', async () => {
  const api = fakeApi(fresh);
  const result = await syncListing({ api, appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: quiet });
  assert.deepEqual(result, { locked: false, versionId: VERSION });
  assert.deepEqual(api.writes, [
    ['PATCH', `/v1/apps/${APP}`],
    ['PATCH', `/v1/appStoreVersions/${VERSION}`],
    ['PATCH', `/v1/appStoreVersionLocalizations/${LOC}`],
    ['PATCH', '/v1/appInfoLocalizations/infoloc1'],
    ['PATCH', `/v1/appInfos/${INFO}`],
    ['PATCH', `/v1/ageRatingDeclarations/${INFO}`],
    ['POST', '/v1/appPriceSchedules'],
    ['POST', '/v2/appAvailabilities'],
    ['POST', '/v1/appStoreReviewDetails'],
    ['POST', '/v1/appScreenshotSets'],
    ['POST', '/v1/appScreenshots'],
    ['PUT', 'https://upload.example/1', shot.length],
    ['PATCH', '/v1/appScreenshots/shot-new'],
    ['PATCH', '/v1/appScreenshotSets/new-appScreenshotSets/relationships/appScreenshots'],
    ['PATCH', `/v1/appStoreVersions/${VERSION}/relationships/build`],
  ]);
});

/** The same app once everything is in place: a second run must write nothing. */
const inSync = {
  ...fresh,
  [`/v1/apps/${APP}?fields[apps]=contentRightsDeclaration`]: { data: { type: 'apps', id: APP, attributes: { contentRightsDeclaration: store.app.contentRights } } },
  [`/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=200`]: {
    data: [{ type: 'appStoreVersions', id: VERSION, attributes: { versionString: '1.0.0', appVersionState: 'PREPARE_FOR_SUBMISSION', copyright: store.app.copyright, releaseType: 'AFTER_APPROVAL' } }],
  },
  [`/v1/appStoreVersions/${VERSION}/appStoreVersionLocalizations`]: {
    data: [{
      type: 'appStoreVersionLocalizations', id: LOC,
      attributes: { locale: 'en-US', description: store.text.description, keywords: store.text.keywords, promotionalText: store.text.promotionalText, supportUrl: store.text.supportUrl, marketingUrl: store.text.marketingUrl, whatsNew: null },
    }],
  },
  [`/v1/appInfos/${INFO}/appInfoLocalizations`]: { data: [{ type: 'appInfoLocalizations', id: 'infoloc1', attributes: { locale: 'en-US', name: store.text.name, subtitle: store.text.subtitle, privacyPolicyUrl: store.text.privacyPolicyUrl } }] },
  [`/v1/appInfos/${INFO}/primaryCategory`]: { data: { type: 'appCategories', id: 'MUSIC' } },
  [`/v1/appInfos/${INFO}/ageRatingDeclaration`]: { data: { type: 'ageRatingDeclarations', id: INFO, attributes: { ...store.app.ageRating } } },
  [`/v1/appPriceSchedules/${APP}/manualPrices?include=appPricePoint&limit=50`]: { data: [{ type: 'appPrices', id: 'p1' }], included: [{ type: 'appPricePoints', id: 'free-usa', attributes: { customerPrice: '0.0' } }] },
  [`/v1/apps/${APP}/appAvailabilityV2`]: { data: { type: 'appAvailabilities', id: APP, attributes: { availableInNewTerritories: true } } },
  [`/v1/appStoreVersions/${VERSION}/appStoreReviewDetail`]: { data: { type: 'appStoreReviewDetails', id: 'rd1', attributes: reviewDetailAttributes(env, fillNotes(store.text.notes, env)) } },
  [`/v1/appStoreVersionLocalizations/${LOC}/appScreenshotSets?limit=50`]: { data: [{ type: 'appScreenshotSets', id: SET, attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }] },
  [`/v1/appScreenshotSets/${SET}/appScreenshots?limit=50`]: { data: [{ type: 'appScreenshots', id: 's1', attributes: { sourceFileChecksum: md5(shot), assetDeliveryState: { state: 'COMPLETE' } } }] },
  [`/v1/appStoreVersions/${VERSION}/build`]: { data: { type: 'builds', id: build.id } },
};

test('running it again writes nothing', async () => {
  const api = fakeApi(inSync);
  const lines = [];
  await syncListing({ api, appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: (l) => lines.push(l) });
  assert.deepEqual(api.writes, []);
  assert.ok(lines.every((l) => /up to date|already set/.test(l)), lines.join('\n'));
});

test('a dry run says what it would write and writes nothing, even for things it would create', async () => {
  const api = fakeApi({ ...fresh, [`/v1/appStoreVersions/${VERSION}/appStoreVersionLocalizations`]: { data: [] } });
  const lines = [];
  await syncListing({ api: withDryRun(api, (l) => lines.push(l)), appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: (l) => lines.push(l) });
  assert.deepEqual(api.writes, []);
  assert.ok(lines.includes('    would PATCH /v1/appStoreVersions/v1 (versionString, copyright)'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('    would POST /v1/appStoreVersionLocalizations (locale, description, keywords')));
  assert.ok(lines.includes('    would POST /v1/appScreenshots (fileName, fileSize → appScreenshotSet)'));
  assert.ok(!lines.join('\n').includes('secret'), 'the password is never printed');
});

test('a version already in review is left alone', async () => {
  const api = fakeApi({
    ...fresh,
    [`/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS&limit=200`]: { data: [{ type: 'appStoreVersions', id: VERSION, attributes: { versionString: '1.0.0', appVersionState: 'WAITING_FOR_REVIEW' } }] },
  });
  assert.deepEqual(await syncListing({ api, appId: APP, versionString: '1.0.0', build, store, screenshots, env, log: quiet }), { locked: true, state: 'WAITING_FOR_REVIEW', versionId: VERSION });
  assert.deepEqual(api.writes, [['PATCH', `/v1/apps/${APP}`]]);
});

test('submitForReview creates a submission, adds the version and submits; a submission in review is left alone', async () => {
  const subs = `/v1/reviewSubmissions?filter[app]=${APP}&filter[platform]=IOS&limit=50`;
  const api = fakeApi({ [subs]: { data: [] }, ['/v1/reviewSubmissions/new-reviewSubmissions/items?include=appStoreVersion&limit=50']: { data: [] } });
  assert.deepEqual(await submitForReview({ api, appId: APP, versionId: VERSION, log: quiet }), { submitted: true, state: 'WAITING_FOR_REVIEW' });
  assert.deepEqual(api.writes, [['POST', '/v1/reviewSubmissions'], ['POST', '/v1/reviewSubmissionItems'], ['PATCH', '/v1/reviewSubmissions/new-reviewSubmissions']]);

  const waiting = fakeApi({ [subs]: { data: [{ type: 'reviewSubmissions', id: 'r1', attributes: { state: 'WAITING_FOR_REVIEW' } }] } });
  assert.deepEqual(await submitForReview({ api: waiting, appId: APP, versionId: VERSION, log: quiet }), { submitted: false, state: 'WAITING_FOR_REVIEW' });
  assert.deepEqual(waiting.writes, []);
});
