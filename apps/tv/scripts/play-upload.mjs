// Google Play Developer API for the TV app (plan 9 §7), with no dependencies: the service account's JWT signed with
// node:crypto, and fetch.
//
//   node scripts/play-upload.mjs <bundle.aab> [--track internal] [--listing]
//                                    upload the bundle to a track (internal testing unless told), with
//                                    store/en-US/whats-new.txt as its release notes; --listing also sends the store
//                                    listing: its words (store/en-US: title, short and full description) and its
//                                    pictures (store/en-US/images: icon, feature graphic, TV banner, TV screenshots)
//   node scripts/play-upload.mjs --check
//                                    is the service account accepted, and may it release the app?
//
// The service account's key comes from PLAY_SERVICE_ACCOUNT_JSON (the JSON itself, as CI's secret holds it) or
// PLAY_SERVICE_ACCOUNT_FILE (its path). Google's API can't create an app, and the first bundle goes up by hand in Play
// Console; after that, a `tv-v*` tag runs this (.github/workflows/tv.yml). docs/tv/release.md has the steps.
import { createSign } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = 'me.tracklistme.playarr.tv';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'en-US');

/** Play's limits on the listing's words, by file in store/<language>/. */
export const LIMITS = { 'title.txt': 30, 'short-description.txt': 80, 'full-description.txt': 4000, 'whats-new.txt': 500 };

/** The service account's key, from the environment; throws with a clear message when it's missing or isn't one. */
export function credentials(env = process.env) {
  const text = env.PLAY_SERVICE_ACCOUNT_JSON || (env.PLAY_SERVICE_ACCOUNT_FILE && readFileSync(env.PLAY_SERVICE_ACCOUNT_FILE, 'utf8'));
  if (!text) throw new Error('Set PLAY_SERVICE_ACCOUNT_JSON (the key itself) or PLAY_SERVICE_ACCOUNT_FILE (its path): see docs/tv/release.md');
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    throw new Error("The service account key isn't JSON: use the file Google Cloud gave when the key was made");
  }
  if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new Error("That JSON isn't a service account key (type service_account, with client_email and private_key)");
  }
  return { email: key.client_email, key: key.private_key, tokenUri: key.token_uri || 'https://oauth2.googleapis.com/token' };
}

/** The signed JWT a service account trades for an access token (RS256, an hour at most). */
export function assertion({ email, key, tokenUri }, now = Date.now()) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(key).toString('base64url')}`;
}

/** What went wrong, in words, from a failed answer. */
export function explain(status, body, what = '') {
  const said = body?.error?.message ?? body?.error_description ?? (typeof body === 'string' ? body : '');
  const doing = what ? ` (${what})` : '';
  if (status === 401 || body?.error === 'invalid_grant') {
    return `Google refused the service account${doing}: check that its key isn't deleted, and this Mac's clock. Google says: ${said}`;
  }
  if (status === 404 || /package not found/i.test(said)) {
    return (
      `Google Play has no app ${PACKAGE} that this service account can see${doing}. Create it in Play Console, upload ` +
      `its first bundle there by hand, and give the service account access (docs/tv/release.md). Google says: ${said}`
    );
  }
  if (status === 403) {
    return (
      `The service account may not do this${doing}: in Play Console → Users and permissions, give it "Release apps to ` +
      `testing tracks" (and "Release to production" for production) on Playarr. Google says: ${said}`
    );
  }
  return `Google Play answered ${status}${doing}. ${said}`.trim();
}

class PlayError extends Error {
  constructor(status, body, what) {
    super(explain(status, body, what));
    this.status = status;
    this.said = body?.error?.message ?? '';
  }
}

/** An access token for the service account. */
export async function accessToken(creds, { fetch = globalThis.fetch, now = Date.now() } = {}) {
  const res = await fetch(creds.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(creds, now) }).toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) throw new PlayError(res.status, body, 'signing in');
  return body.access_token;
}

/** Calls on the API with the token: `call('POST', '/edits', { json })`, or `{ upload: Buffer }` for the upload host. */
export function client(token, { fetch = globalThis.fetch } = {}) {
  return async function call(method, path, { json, upload, type = 'application/octet-stream', query, what } = {}) {
    const url = `${upload ? UPLOAD : API}/applications/${PACKAGE}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const headers = { Authorization: `Bearer ${token}` };
    let body;
    if (upload) {
      headers['Content-Type'] = type;
      body = upload;
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) throw new PlayError(res.status, parsed, what);
    return parsed;
  };
}

/** The listing's words from store/<language>/, checked against Play's limits. */
export function readStore(dir = STORE, { listing = false } = {}) {
  const files = listing ? Object.keys(LIMITS) : ['whats-new.txt'];
  const out = {};
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8').trim();
    if (!text) throw new Error(`${file} is empty`);
    // Play counts characters as Java does: UTF-16 units.
    if (text.length > LIMITS[file]) throw new Error(`${file} is ${text.length} characters; Google Play takes ${LIMITS[file]} at most`);
    out[file] = text;
  }
  return out;
}

/** Play's image types, by file in store/<language>/images/ (a folder holds several, in name order). */
export const IMAGES = { icon: 'icon.png', featureGraphic: 'feature-graphic.png', tvBanner: 'tv-banner.png', tvScreenshots: 'tv-screenshots' };

/** The listing's pictures, by Play's image type; a type without its file or folder is left as Play has it. */
export function readImages(dir = join(STORE, 'images')) {
  const out = {};
  for (const [type, name] of Object.entries(IMAGES)) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    out[type] = name.endsWith('.png')
      ? [readFileSync(path)]
      : readdirSync(path).filter((f) => f.endsWith('.png')).sort().map((f) => readFileSync(join(path, f)));
  }
  return out;
}

/**
 * Sends a bundle to a track in one edit: the bundle, the listing's words if asked, the track's release (its notes from
 * whats-new.txt), then commits. An app Play still has as a draft (never sent for review) takes only draft releases, and
 * some edits can't be sent for review on their own; both are retried as Play asks. A failed edit is deleted.
 */
export async function upload(call, { bundle, track = 'internal', words, images = {}, log = console.log }) {
  const edit = await call('POST', '/edits', { json: {}, what: 'starting an edit' });
  const id = edit.id;
  try {
    const sent = await call('POST', `/edits/${id}/bundles`, { upload: bundle, query: { uploadType: 'media' }, what: 'uploading the bundle' });
    const versionCode = String(sent.versionCode);
    log(`Uploaded version code ${versionCode}`);
    if (words['title.txt']) {
      await call('PUT', `/edits/${id}/listings/en-US`, {
        json: { language: 'en-US', title: words['title.txt'], shortDescription: words['short-description.txt'], fullDescription: words['full-description.txt'] },
        what: 'the store listing',
      });
      log('Sent the store listing (en-US)');
    }
    for (const [type, files] of Object.entries(images)) {
      if (!files.length) continue;
      // Replaced, not added to: Play keeps every picture uploaded until it's deleted.
      await call('DELETE', `/edits/${id}/listings/en-US/${type}`, { what: `the listing's ${type}` });
      for (const file of files) {
        await call('POST', `/edits/${id}/listings/en-US/${type}`, { upload: file, type: 'image/png', query: { uploadType: 'media' }, what: `the listing's ${type}` });
      }
      log(`Sent ${files.length} ${type}`);
    }
    const release = (status) => ({
      track,
      releases: [{ versionCodes: [versionCode], status, releaseNotes: [{ language: 'en-US', text: words['whats-new.txt'] }] }],
    });
    try {
      await call('PUT', `/edits/${id}/tracks/${track}`, { json: release('completed'), what: `the ${track} track` });
    } catch (e) {
      if (!/draft/i.test(e.said ?? '')) throw e;
      log('Play has the app as a draft, so the release is a draft too: roll it out in Play Console');
      await call('PUT', `/edits/${id}/tracks/${track}`, { json: release('draft'), what: `the ${track} track` });
    }
    try {
      await call('POST', `/edits/${id}:commit`, { what: 'committing the edit' });
    } catch (e) {
      if (!/changesNotSentForReview/.test(e.said ?? '')) throw e;
      await call('POST', `/edits/${id}:commit`, { query: { changesNotSentForReview: 'true' }, what: 'committing the edit' });
      log('Committed without sending for review: send the changes for review in Play Console');
    }
    log(`Version code ${versionCode} is on the ${track} track`);
    return versionCode;
  } catch (e) {
    await call('DELETE', `/edits/${id}`).catch(() => {});
    throw e;
  }
}

/** Opens an edit and deletes it: the key works, the app exists and the service account may change it. */
export async function check(call, log = console.log) {
  const edit = await call('POST', '/edits', { json: {}, what: 'starting an edit' });
  const tracks = await call('GET', `/edits/${edit.id}/tracks`, { what: 'listing tracks' }).catch(() => null);
  await call('DELETE', `/edits/${edit.id}`).catch(() => {});
  const names = (tracks?.tracks ?? []).map((t) => t.track).join(', ');
  log(`The service account may release ${PACKAGE}${names ? `; its tracks: ${names}` : ''}`);
}

export function parseArgs(argv) {
  const args = { track: 'internal', listing: false, check: false, bundle: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--track') args.track = argv[++i];
    else if (a === '--listing') args.listing = true;
    else if (a === '--check') args.check = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else args.bundle = a;
  }
  if (!args.check && !args.bundle) throw new Error('Usage: play-upload.mjs <bundle.aab> [--track internal] [--listing] | --check');
  if (!args.track) throw new Error('--track needs a name (internal, alpha, beta, production)');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const call = client(await accessToken(credentials()));
  if (args.check) return check(call);
  const words = readStore(STORE, { listing: args.listing });
  const images = args.listing ? readImages() : {};
  console.log(`Sending ${basename(args.bundle)} to Google Play (${args.track})`);
  await upload(call, { bundle: readFileSync(args.bundle), track: args.track, words, images });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
