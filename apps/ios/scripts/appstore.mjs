// Brings App Store Connect in line with apps/ios/store, then submits the version for review. Every step reads
// first and writes only what differs, so running it again changes nothing; under withDryRun it only says what
// it would write. `api` is asc.mjs over HTTP (release.mjs makes it) or an in-memory fake in the tests:
//   get(path), getOrNull(path) (null for a 404), post(path, body), patch(path, body), del(path),
//   put({ method, url, headers, body }) for screenshot bytes, sleep(ms)
import { readFileSync } from 'node:fs';
import {
  availability, changes, editableAppInfo, FIELDS, fillNotes, freePriceSchedule, names, pickSubmission, pickVersion, rel,
  reviewDetailAttributes, screenshotPlan, uploadParts,
} from './store.mjs';

export const list = (res) => (Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : []);
export const one = (res) => list(res)[0] ?? null;

const describe = (body) => {
  const data = body?.data;
  if (!data || Array.isArray(data) || !data.type || (!data.attributes && !data.relationships)) return 'relationship';
  return [data.attributes && names(data.attributes), data.relationships && `→ ${Object.keys(data.relationships).join(', ')}`].filter(Boolean).join(' ');
};

/**
 * `api` with its writes logged instead of sent. What a dry run "creates" gets an id starting with dry-run-,
 * and reads under such an id find nothing, so later steps say what they'd create there too.
 */
export function withDryRun(api, log) {
  let n = 0;
  const pretend = (path) => path.includes('/dry-run-');
  return {
    ...api,
    dryRun: true,
    get: async (path) => (pretend(path) ? { data: [] } : api.get(path)),
    getOrNull: async (path) => (pretend(path) ? null : api.getOrNull(path)),
    post: async (path, body) => {
      log(`    would POST ${path} (${describe(body)})`);
      return { data: { ...body.data, id: `dry-run-${body.data.type}-${++n}`, attributes: body.data.attributes ?? {} } };
    },
    patch: async (path, body) => {
      log(`    would PATCH ${path} (${describe(body)})`);
      return { data: body.data };
    },
    del: async (path) => {
      log(`    would DELETE ${path}`);
      return null;
    },
    put: async () => {},
  };
}

/** Create the resource with `desired`, or PATCH the attributes that differ. Answers the resource. */
async function upsert(api, log, { label, type, current, desired, relationships }) {
  if (!current) {
    const { data } = await api.post(`/v1/${type}`, { data: { type, attributes: desired, ...(relationships && { relationships }) } });
    log(`  ${label}: created`);
    return data;
  }
  const diff = changes(current.attributes, desired);
  if (Object.keys(diff).length) await api.patch(`/v1/${type}/${current.id}`, { data: { type, id: current.id, attributes: diff } });
  log(`  ${label}: ${Object.keys(diff).length ? names(diff) : 'up to date'}`);
  return current;
}

const textFor = (text, on) => Object.fromEntries(FIELDS.filter((f) => f.on === on).map((f) => [f.key, text[f.key]]));

/**
 * The listing, the review details, the screenshots and the build for `versionString`. Answers
 * { locked, state, versionId }: locked when that version is already in review, approved or live.
 */
export async function syncListing({ api, appId, versionString, build, store, screenshots, env, log = console.log }) {
  const { text, app: settings, locale } = store;

  const app = one(await api.get(`/v1/apps/${appId}?fields[apps]=contentRightsDeclaration`));
  await upsert(api, log, { label: 'Content rights', type: 'apps', current: app, desired: { contentRightsDeclaration: settings.contentRights } });

  const versions = list(await api.get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=200`));
  const pick = pickVersion(versions, versionString);
  if (pick.action === 'locked') return { locked: true, state: pick.state, versionId: pick.version.id };
  const wanted = { versionString, copyright: settings.copyright, releaseType: settings.releaseType };
  let version = pick.version;
  if (pick.action === 'create') {
    ({ data: version } = await api.post('/v1/appStoreVersions', {
      data: { type: 'appStoreVersions', attributes: { platform: 'IOS', ...wanted }, relationships: { app: rel('apps', appId) } },
    }));
    log(`  App Store version ${versionString}: created`);
  } else {
    const label = pick.action === 'rename' ? `App Store version ${version.attributes.versionString} → ${versionString}` : `App Store version ${versionString}`;
    await upsert(api, log, { label, type: 'appStoreVersions', current: version, desired: wanted });
  }
  // App Store Connect refuses "What's New" on an app's first version.
  const firstRelease = versions.every((v) => v.id === version.id);
  const versionText = textFor(text, 'versionLocalization');
  if (firstRelease) delete versionText.whatsNew;

  const localizations = list(await api.get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`));
  const localization = await upsert(api, log, {
    label: `Description, keywords and links (${locale})`,
    type: 'appStoreVersionLocalizations',
    current: localizations.find((l) => l.attributes.locale === locale),
    desired: { locale, ...versionText },
    relationships: { appStoreVersion: rel('appStoreVersions', version.id) },
  });

  const info = editableAppInfo(list(await api.get(`/v1/apps/${appId}/appInfos`)));
  if (!info) throw new Error('App Store Connect has no app information that can be edited right now (is a version in review?).');
  const infoLocalizations = list(await api.get(`/v1/appInfos/${info.id}/appInfoLocalizations`));
  await upsert(api, log, {
    label: `Name, subtitle and privacy policy (${locale})`,
    type: 'appInfoLocalizations',
    current: infoLocalizations.find((l) => l.attributes.locale === locale),
    desired: { locale, ...textFor(text, 'appInfoLocalization') },
    relationships: { appInfo: rel('appInfos', info.id) },
  });
  const category = one(await api.get(`/v1/appInfos/${info.id}/primaryCategory`));
  if (category?.id === settings.primaryCategory) log('  Category: up to date');
  else {
    await api.patch(`/v1/appInfos/${info.id}`, { data: { type: 'appInfos', id: info.id, relationships: { primaryCategory: rel('appCategories', settings.primaryCategory) } } });
    log(`  Category: ${settings.primaryCategory}`);
  }
  const rating = one(await api.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`));
  await upsert(api, log, { label: 'Age rating', type: 'ageRatingDeclarations', current: rating, desired: settings.ageRating });

  const prices = await api.getOrNull(`/v1/appPriceSchedules/${appId}/manualPrices?include=appPricePoint&limit=50`);
  if ((prices?.included ?? []).some((p) => p.type === 'appPricePoints' && Number(p.attributes.customerPrice) === 0)) log('  Price: up to date (free)');
  else {
    const points = list(await api.get(`/v1/apps/${appId}/appPricePoints?filter[territory]=USA&limit=200`));
    const free = points.find((p) => Number(p.attributes.customerPrice) === 0);
    if (!free) throw new Error('App Store Connect lists no free price point for the United States.');
    await api.post('/v1/appPriceSchedules', freePriceSchedule(appId, free.id));
    log('  Price: free');
  }
  if (await api.getOrNull(`/v1/apps/${appId}/appAvailabilityV2`)) log('  Availability: already set (App Store Connect → Pricing and Availability changes it)');
  else {
    const territories = list(await api.get('/v1/territories?limit=200')).map((t) => t.id);
    await api.post('/v2/appAvailabilities', availability(appId, territories, settings.availableInNewTerritories));
    log(`  Availability: all ${territories.length} countries and regions`);
  }

  const detail = one(await api.get(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`));
  await upsert(api, log, {
    label: 'App Review information',
    type: 'appStoreReviewDetails',
    current: detail,
    desired: reviewDetailAttributes(env, fillNotes(text.notes, env)),
    relationships: { appStoreVersion: rel('appStoreVersions', version.id) },
  });

  const sets = list(await api.get(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=50`));
  for (const local of screenshots) {
    let set = sets.find((s) => s.attributes.screenshotDisplayType === local.displayType);
    if (!set) {
      ({ data: set } = await api.post('/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: local.displayType },
          relationships: { appStoreVersionLocalization: rel('appStoreVersionLocalizations', localization.id) },
        },
      }));
    }
    const remote = list(await api.get(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`));
    const plan = screenshotPlan(local.files, remote);
    if (plan.unchanged) {
      log(`  Screenshots ${local.folder}: up to date`);
      continue;
    }
    for (const id of plan.remove) await api.del(`/v1/appScreenshots/${id}`);
    const uploaded = [];
    for (const file of plan.upload) uploaded.push({ file, id: await uploadScreenshot(api, set.id, file) });
    const order = local.files.map((f) => [...plan.keep, ...uploaded].find((s) => s.file === f).id);
    await api.patch(`/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: order.map((id) => ({ type: 'appScreenshots', id })) });
    log(`  Screenshots ${local.folder}: ${plan.upload.length} uploaded, ${plan.remove.length} removed, ${plan.keep.length} kept`);
  }

  const attached = one(await api.get(`/v1/appStoreVersions/${version.id}/build`));
  if (!build.id) log(`  Build: ${build.number} once it's uploaded`);
  else if (attached?.id === build.id) log(`  Build ${build.number}: up to date`);
  else {
    await api.patch(`/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
    log(`  Build ${build.number}: chosen for this version`);
  }
  return { locked: false, versionId: version.id };
}

/** Reserve, send the bytes, commit, and wait until App Store Connect has processed the screenshot. */
async function uploadScreenshot(api, setId, file) {
  const { data: reserved } = await api.post('/v1/appScreenshots', {
    data: { type: 'appScreenshots', attributes: { fileName: file.name, fileSize: file.size }, relationships: { appScreenshotSet: rel('appScreenshotSets', setId) } },
  });
  if (api.dryRun) return reserved.id;
  for (const part of uploadParts(readFileSync(file.path), reserved.attributes.uploadOperations)) await api.put(part);
  await api.patch(`/v1/appScreenshots/${reserved.id}`, { data: { type: 'appScreenshots', id: reserved.id, attributes: { uploaded: true, sourceFileChecksum: file.md5 } } });
  for (let tries = 0; tries < 90; tries++) {
    const { data } = await api.get(`/v1/appScreenshots/${reserved.id}?fields[appScreenshots]=assetDeliveryState`);
    const { state, errors = [] } = data.attributes.assetDeliveryState ?? {};
    if (state === 'COMPLETE') return reserved.id;
    if (state === 'FAILED') throw new Error(`App Store Connect couldn't process ${file.name}: ${errors.map((e) => e.description ?? e.code).join(' ')}`);
    await api.sleep(2000);
  }
  throw new Error(`App Store Connect still hasn't processed ${file.name} after 3 minutes.`);
}

/** Add the version to a review submission (a draft, or a new one) and submit it. */
export async function submitForReview({ api, appId, versionId, log = console.log }) {
  const pick = pickSubmission(list(await api.get(`/v1/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&limit=50`)));
  if (pick.action === 'wait') {
    log(`  Review submission: already ${pick.submission.attributes.state}`);
    return { submitted: false, state: pick.submission.attributes.state };
  }
  let submission = pick.submission;
  if (!submission) {
    ({ data: submission } = await api.post('/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: rel('apps', appId) } },
    }));
  }
  const items = list(await api.get(`/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=50`));
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === versionId)) {
    await api.post('/v1/reviewSubmissionItems', {
      data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: rel('reviewSubmissions', submission.id), appStoreVersion: rel('appStoreVersions', versionId) } },
    });
  }
  await api.patch(`/v1/reviewSubmissions/${submission.id}`, { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
  log('  Review submission: submitted');
  return { submitted: true, state: 'WAITING_FOR_REVIEW' };
}
